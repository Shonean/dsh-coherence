/**
 * Memory service (`ctx.memory`): the three-layer working / episodic / semantic
 * memory with budgeted recall and the four-state machine. Writing a semantic
 * claim whose subject already has a conflicting active claim marks the old one
 * `contradicted` and stores the new one `tentative` — the suite's first
 * implementation of the "same-dimension contradiction" idea from the AGI brief.
 * The offline consolidation that replays episodes into semantic claims lands in
 * the consolidation milestone.
 *
 * Memory is sharded per workspace (see `workspace-shards.ts`): every method
 * takes an optional `workspaceId` and a caller without one uses the legacy
 * shard, so two workspaces never recall or consolidate each other's notes.
 * @module dsh-coherence/src/service/memory
 */

import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  memoryDomain,
  type EpisodicEntry,
  type MemoryRuntimeState,
  type SemanticClaim,
  type WorkingEntry,
} from '../domain/memory.ts'
import type { AgentType, MemoryState } from '../types.ts'
import type { MemoryConfig } from '../config.ts'
import { WorkspaceShards, type WorkspaceShard } from '../workspace-shards.ts'

/** One of the three memory layers. */
export type MemoryLayer = 'working' | 'episodic' | 'semantic'

/** A reference to one stored memory entry. */
export interface MemoryRef {
  layer: MemoryLayer
  key: string
}

/** Input to {@link MemoryService.write}. */
export interface MemoryWriteInput {
  layer: MemoryLayer
  /** The content to remember: working fact, episode summary, or semantic claim. */
  content: string
  /** Semantic subject; claims with the same subject are deduplicated or conflict-marked. */
  subject?: string
  agentType?: AgentType
  sessionId?: string
  /** Working-memory entry kind. */
  kind?: WorkingEntry['kind']
  importance?: number
  tags?: string[]
  source?: { agentType: AgentType; sessionId: string; messageId: string }
  /** Episodic episode id; auto-generated when absent. */
  episodeId?: string
}

/** Recall query. */
export interface MemoryRecallQuery {
  query?: string
  maxTokens?: number
  layers?: MemoryLayer[]
  filterAgent?: AgentType
  sessionId?: string
  includeOutdated?: boolean
  /** Shard to read; the legacy shard is read when omitted. */
  workspaceId?: string
}

/** One ranked recall hit. */
export interface RankedMemoryItem {
  layer: MemoryLayer
  key: string
  content: string
  subject?: string
  agentType: AgentType
  sessionId: string
  importance: number
  state: MemoryState
  score: number
}

/** Result of {@link MemoryService.recall}. */
export interface MemoryRecallResult {
  items: RankedMemoryItem[]
  budgetUsed: { working: number; episodic: number; semantic: number }
  durationMs: number
}

/** List filter. */
export interface MemoryFilter {
  layer?: MemoryLayer
  agentType?: AgentType
  sessionId?: string
  state?: MemoryState
}

/** A stored entry with its reference, across layers. */
export type MemoryEntry = (
  | { layer: 'working'; key: string } & WorkingEntry
  | { layer: 'episodic'; key: string } & EpisodicEntry
  | { layer: 'semantic'; key: string } & SemanticClaim
)

/** Counts per layer. */
export interface MemoryStats {
  working: number
  episodic: number
  semantic: number
}

/** Result of one consolidation run. */
export interface ConsolidationReport {
  shard: string
  episodesConsolidated: number
  claimsAdded: number
  claimsMerged: number
  durationMs: number
}

/** Memory service construction options. */
export interface MemoryServiceOptions {
  budget?: MemoryConfig['budget']
  recallMaxTokens?: number
}

/** The per-shard table set. */
export interface MemoryTables {
  working: KvTable<string, WorkingEntry>
  episodic: KvTable<string, EpisodicEntry>
  semantic: KvTable<string, SemanticClaim>
  state: KvTable<string, MemoryRuntimeState>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

type MemoryEntryValue = WorkingEntry | EpisodicEntry | SemanticClaim
/** A stored entry paired with its domain key, as the service iterates them. */
interface KeyedEntry {
  key: string
  value: MemoryEntryValue
}

const DEFAULT_BUDGET = { working: 0.45, episodic: 0.30, semantic: 0.25 }

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function workingKey(): string {
  return `w:${randomUUID()}`
}

function episodeKey(episodeId: string): string {
  return `e:${episodeId}`
}

/** Stable dedup key of one semantic claim: a short sha of subject + claim. */
function semanticKey(subject: string, claim: string): string {
  const hash = createHash('sha256').update(`${subject} ${claim}`).digest('hex').slice(0, 16)
  return `s:${hash}`
}

/** The display text of one entry, per layer. */
function entryText(layer: MemoryLayer, entry: MemoryEntryValue): string {
  switch (layer) {
    case 'working':
      return (entry as WorkingEntry).content
    case 'episodic':
      return (entry as EpisodicEntry).summary
    case 'semantic':
      return `${(entry as SemanticClaim).subject} ${(entry as SemanticClaim).claim}`
  }
}

/** The relevance timestamp of one entry, per layer. */
function entryTime(layer: MemoryLayer, entry: MemoryEntryValue): number {
  switch (layer) {
    case 'working':
      return (entry as WorkingEntry).createdAt
    case 'episodic':
      return (entry as EpisodicEntry).startedAt
    case 'semantic':
      return (entry as SemanticClaim).consolidatedAt ?? Date.now()
  }
}

/** The strength of one entry: importance for working/episodic, confidence for semantic. */
function entryStrength(layer: MemoryLayer, entry: MemoryEntryValue): number {
  return layer === 'semantic' ? (entry as SemanticClaim).confidence : (entry as WorkingEntry | EpisodicEntry).importance
}

/** Rough token estimate: ~4 chars per token across the entry's text. */
function estimateTokens(layer: MemoryLayer, entry: MemoryEntryValue): number {
  return Math.max(1, Math.ceil(entryText(layer, entry).length / 4))
}

/** The memory service. Owns the memory domain family and the three-layer API. */
export class MemoryService extends Service {
  /** The storage domain form must be present before the domain opens. */
  static inject = ['storageDomain']

  private shards!: WorkspaceShards<MemoryTables>
  private readonly budget: MemoryConfig['budget']
  private readonly recallMaxTokens: number

  constructor(ctx: Context, options: MemoryServiceOptions = {}) {
    super(ctx, 'memory')
    this.budget = options.budget ?? DEFAULT_BUDGET
    this.recallMaxTokens = options.recallMaxTokens ?? 4096
  }

  /** Open the legacy shard plus every registered workspace's shard. */
  protected async [Service.init](): Promise<void> {
    this.shards = new WorkspaceShards<MemoryTables>(this.ctx, 'memory', {
      spec: domainName => ({ ...memoryDomain, name: domainName }),
      open: (domain: Domain<typeof memoryDomain>): MemoryTables => ({
        working: domain.table('working'),
        episodic: domain.table('episodic'),
        semantic: domain.table('semantic'),
        state: domain.table('state'),
      }),
    })
    await this.shards.init()
  }

  /**
   * Re-open shards for workspaces that appeared since the last refresh.
   * @returns the workspaces newly sharded by this call.
   */
  refreshShards(): Promise<WorkspaceShard<MemoryTables>[]> {
    return this.shards.refresh()
  }

  /**
   * Resolve a project directory to a workspace shard id.
   * @param projectDir - the directory to resolve.
   * @returns the workspace id, or `undefined` when unregistered.
   */
  resolveWorkspaceId(projectDir?: string): Promise<string | undefined> {
    return this.shards.resolveId(projectDir)
  }

  /**
   * Write one entry to a layer. Semantic writes deduplicate by subject+claim,
   * merge repeated evidence, and mark a conflicting active claim `contradicted`
   * while storing the new claim `tentative`.
   * @param input - the entry to remember.
   * @param workspaceId - target shard; omitted writes the legacy shard.
   * @returns the reference of the stored (or merged) entry.
   */
  async write(input: MemoryWriteInput, workspaceId?: string): Promise<MemoryRef> {
    const tables = this.shards.require(workspaceId).data
    switch (input.layer) {
      case 'working':
        return this.writeWorking(tables, input)
      case 'episodic':
        return this.writeEpisodic(tables, input)
      case 'semantic':
        return this.writeSemantic(tables, input)
    }
  }

  /**
   * Recall the top-scored entries across the requested layers, each capped by
   * its budget share of `maxTokens`. Entries that are `outdated` or
   * `contradicted` are excluded unless `includeOutdated` is set.
   * @param query - keyword, token budget, layer, identity, and workspace filters.
   * @returns ranked items plus the budget actually used per layer.
   */
  recall(query: MemoryRecallQuery = {}): MemoryRecallResult {
    const startedAt = Date.now()
    const maxTokens = query.maxTokens ?? this.recallMaxTokens
    const layers = query.layers ?? (['working', 'episodic', 'semantic'] as MemoryLayer[])
    const tables = this.shards.require(query.workspaceId).data
    const layerTokens: Record<MemoryLayer, number> = {
      working: Math.floor(maxTokens * this.budget.working),
      episodic: Math.floor(maxTokens * this.budget.episodic),
      semantic: Math.floor(maxTokens * this.budget.semantic),
    }
    const items: RankedMemoryItem[] = []
    const budgetUsed = { working: 0, episodic: 0, semantic: 0 }
    for (const layer of layers) {
      const scored = this.candidates(tables, layer)
        .filter(({ value }) => value.state === 'active'
          || (query.includeOutdated && value.state === 'outdated'))
        .filter(({ value }) => query.filterAgent === undefined || value.agentType === query.filterAgent)
        .filter(({ value }) => query.sessionId === undefined || value.sessionId === query.sessionId)
        .map(({ key, value }) => ({
          item: this.toRanked(layer, key, value, query.query ?? '', startedAt),
          tokens: estimateTokens(layer, value),
        }))
        .sort((a, b) => b.item.score - a.item.score)
      let used = 0
      for (const { item, tokens } of scored) {
        if (used + tokens > layerTokens[layer]) {
          if (used === 0) {
            items.push(item)
            used += tokens
          }
          break
        }
        items.push(item)
        used += tokens
      }
      budgetUsed[layer] = used
    }
    return { items, budgetUsed, durationMs: Date.now() - startedAt }
  }

  /**
   * List stored entries across layers of one shard.
   * @param filter - optional layer, agent, session, and state filters.
   * @param workspaceId - target shard; omitted reads the legacy shard.
   * @returns matching entries in arbitrary order.
   */
  list(filter: MemoryFilter = {}, workspaceId?: string): MemoryEntry[] {
    const tables = this.shards.require(workspaceId).data
    const out: MemoryEntry[] = []
    for (const [key, entry] of tables.working.entries()) {
      if (filter.layer !== undefined && filter.layer !== 'working') continue
      if (this.matches(entry, filter)) out.push({ key, ...entry })
    }
    for (const [key, entry] of tables.episodic.entries()) {
      if (filter.layer !== undefined && filter.layer !== 'episodic') continue
      if (this.matches(entry, filter)) out.push({ key, ...entry })
    }
    for (const [key, entry] of tables.semantic.entries()) {
      if (filter.layer !== undefined && filter.layer !== 'semantic') continue
      if (this.matches(entry, filter)) out.push({ key, ...entry })
    }
    return out
  }

  /**
   * Soft-delete one entry by marking it `outdated`.
   * @param ref - the entry to forget.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @param supersededBy - optional reference of the entry that superseded it.
   */
  async forget(ref: MemoryRef, workspaceId?: string, supersededBy?: string): Promise<void> {
    await this.markState(ref, workspaceId, 'outdated', supersededBy)
  }

  /**
   * Transition one entry's state.
   * @param ref - the entry to transition.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @param state - the new state.
   * @param supersededBy - the reference of the entry that superseded it, when any.
   */
  async markState(ref: MemoryRef, workspaceId: string | undefined, state: MemoryState, supersededBy?: string): Promise<void> {
    const tables = this.shards.require(workspaceId).data
    const table = this.tableOf(tables, ref.layer)
    const key = ref.key
    const existing = table.get(key)
    if (existing === undefined) {
      throw new Error(`memory: no ${ref.layer} entry at '${ref.key}'`)
    }
    const updated: MemoryEntryValue = { ...existing, state, supersededBy } as MemoryEntryValue
    await table.put(key, updated)
  }

  /**
   * Count stored entries per layer in one shard.
   * @param workspaceId - target shard; the legacy shard is counted when omitted.
   * @returns the per-layer entry counts.
   */
  stats(workspaceId?: string): MemoryStats {
    const tables = this.shards.require(workspaceId).data
    return {
      working: tables.working.size,
      episodic: tables.episodic.size,
      semantic: tables.semantic.size,
    }
  }

  /**
   * Consolidate every open shard: replay each shard's active episodes into
   * that shard's semantic claims (subject = episode agent, claim = episode
   * summary), dedup by subject+claim, mark the replayed episodes `outdated`,
   * and stamp that shard's singleton state row.
   * @returns one report per shard that had active episodes.
   */
  async consolidateAll(): Promise<ConsolidationReport[]> {
    const reports: ConsolidationReport[] = []
    for (const shard of this.shards.all()) {
      const report = await this.consolidateShard(shard)
      if (report.episodesConsolidated > 0 || report.claimsAdded > 0) reports.push(report)
    }
    return reports
  }

  /**
   * The CLS-style offline consolidation for one shard: replay every active
   * episode into a semantic claim (subject = episode agent, claim = episode
   * summary), dedup by subject+claim, mark the replayed episodes `outdated`,
   * and stamp the singleton state row. LLM-based summarization is a future
   * enhancement — the current distill is the episode's own summary.
   * @param shardId - the shard to consolidate (legacy when omitted).
   * @returns how many episodes were consolidated and claims added or merged.
   */
  async consolidate(shardId?: string): Promise<ConsolidationReport> {
    return this.consolidateShard(this.shards.require(shardId))
  }

  private async consolidateShard(shard: WorkspaceShard<MemoryTables>): Promise<ConsolidationReport> {
    const startedAt = Date.now()
    const tables = shard.data
    const episodes = [...tables.episodic.entries()]
      .filter(([, episode]) => episode.state === 'active')
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
    let claimsAdded = 0
    let claimsMerged = 0
    for (const [, episode] of episodes) {
      const claim = episode.summary.trim()
      if (claim.length === 0) continue
      const key = semanticKey(episode.agentType, claim)
      const existing = tables.semantic.get(key)
      if (existing === undefined) {
        await tables.semantic.put(key, {
          layer: 'semantic',
          subject: episode.agentType,
          claim,
          agentType: episode.agentType,
          sessionId: episode.sessionId,
          confidence: clamp01(episode.importance),
          sourceCount: 1,
          sources: [{ layer: 'episodic', key: episodeKey(episode.episodeId) }],
          tags: [],
          state: 'active',
          consolidatedAt: startedAt,
        })
        claimsAdded++
      } else {
        await tables.semantic.put(key, { ...existing, sourceCount: existing.sourceCount + 1, lastVerifiedAt: startedAt })
        claimsMerged++
      }
    }
    for (const [key, episode] of episodes) {
      await tables.episodic.put(key, { ...episode, state: 'outdated' })
    }
    if (episodes.length > 0) {
      await tables.state.put('state', {
        budget: this.budget,
        lastConsolidationAt: startedAt,
        workingTokens: 0,
      })
    }
    return {
      shard: shard.workspaceId,
      episodesConsolidated: episodes.length,
      claimsAdded,
      claimsMerged,
      durationMs: Date.now() - startedAt,
    }
  }

  private async writeWorking(tables: MemoryTables, input: MemoryWriteInput): Promise<MemoryRef> {
    const entry: WorkingEntry = {
      layer: 'working',
      agentType: input.agentType ?? 'main',
      sessionId: input.sessionId ?? 'main',
      kind: input.kind ?? 'fact',
      content: input.content,
      importance: clamp01(input.importance ?? 0.5),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      source: input.source,
      state: 'active',
    }
    const key = workingKey()
    await tables.working.put(key, entry)
    return { layer: 'working', key }
  }

  private async writeEpisodic(tables: MemoryTables, input: MemoryWriteInput): Promise<MemoryRef> {
    const episodeId = input.episodeId ?? randomUUID()
    const entry: EpisodicEntry = {
      layer: 'episodic',
      episodeId,
      agentType: input.agentType ?? 'main',
      sessionId: input.sessionId ?? 'main',
      startedAt: Date.now(),
      summary: input.content,
      events: [],
      linkedTaskIds: [],
      importance: clamp01(input.importance ?? 0.5),
      state: 'active',
    }
    const key = episodeKey(episodeId)
    await tables.episodic.put(key, entry)
    return { layer: 'episodic', key }
  }

  private async writeSemantic(tables: MemoryTables, input: MemoryWriteInput): Promise<MemoryRef> {
    const subject = (input.subject ?? '').trim()
    const claim = input.content.trim()
    if (claim.length === 0) throw new Error('memory: semantic claim must be non-empty')
    const key = semanticKey(subject, claim)
    const existing = tables.semantic.get(key)
    if (existing !== undefined) {
      const merged: SemanticClaim = {
        ...existing,
        confidence: Math.max(existing.confidence, clamp01(input.importance ?? 0.6)),
        sourceCount: existing.sourceCount + 1,
        lastVerifiedAt: Date.now(),
        state: existing.state === 'contradicted' ? 'active' : existing.state,
      }
      await tables.semantic.put(key, merged)
      return { layer: 'semantic', key }
    }
    let conflicted = false
    if (subject.length > 0) {
      for (const [oldKey, old] of tables.semantic.entries()) {
        if (old.subject === subject && old.claim !== claim && old.state === 'active') {
          await tables.semantic.put(oldKey, { ...old, state: 'contradicted' })
          conflicted = true
        }
      }
    }
    const entry: SemanticClaim = {
      layer: 'semantic',
      subject,
      claim,
      agentType: input.agentType ?? 'main',
      sessionId: input.sessionId ?? 'main',
      confidence: clamp01(input.importance ?? 0.6),
      sourceCount: 1,
      sources: input.source !== undefined ? [{ layer: 'semantic', key }] : [],
      tags: input.tags ?? [],
      state: conflicted ? 'tentative' : 'active',
      consolidatedAt: Date.now(),
    }
    await tables.semantic.put(key, entry)
    return { layer: 'semantic', key }
  }

  private candidates(tables: MemoryTables, layer: MemoryLayer): KeyedEntry[] {
    switch (layer) {
      case 'working':
        return [...tables.working.entries()].map(([key, value]) => ({ key, value }))
      case 'episodic':
        return [...tables.episodic.entries()].map(([key, value]) => ({ key, value }))
      case 'semantic':
        return [...tables.semantic.entries()].map(([key, value]) => ({ key, value }))
    }
  }

  private toRanked(layer: MemoryLayer, key: string, value: MemoryEntryValue, query: string, now: number): RankedMemoryItem {
    const content = entryText(layer, value)
    const strength = entryStrength(layer, value)
    const recency = 1 / (1 + (now - entryTime(layer, value)) / 86_400_000)
    const keyword = query.length > 0 && content.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0
    const subject = layer === 'semantic' ? (value as SemanticClaim).subject : undefined
    return {
      layer,
      key,
      content,
      ...(subject !== undefined ? { subject } : {}),
      agentType: value.agentType ?? 'main',
      sessionId: value.sessionId ?? 'main',
      importance: strength,
      state: value.state,
      score: strength * 0.5 + recency * 0.3 + keyword,
    }
  }

  private matches(entry: WorkingEntry | EpisodicEntry | SemanticClaim, filter: MemoryFilter): boolean {
    if (filter.agentType !== undefined && entry.agentType !== filter.agentType) return false
    if (filter.sessionId !== undefined && entry.sessionId !== filter.sessionId) return false
    if (filter.state !== undefined && entry.state !== filter.state) return false
    return true
  }

  private tableOf(tables: MemoryTables, layer: MemoryLayer): KvTable<string, MemoryEntryValue> {
    switch (layer) {
      case 'working':
        return tables.working
      case 'episodic':
        return tables.episodic
      case 'semantic':
        return tables.semantic
    }
  }
}
