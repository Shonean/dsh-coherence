/**
 * The coherence Remote gateway (`ctx.coherence`): the typed read-only Host
 * surface the web Coherence Hub consumes. It projects the memory and transcript
 * services into JSON-safe wire rows — the same data the MCP bridge serves to
 * external agents, served to the browser half through the platform's typed
 * Remote assembly instead of the loopback MCP port.
 *
 * Shard scope: every read takes an optional `workspaceId`; `undefined` reads
 * the legacy shard (the MCP tools' default scope). `listWorkspaces` refreshes
 * the shard managers first, so a workspace registered after startup is served
 * from its own shard instead of silently falling back to legacy.
 * @module dsh-coherence/src/remote
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { MemoryEntry, MemoryService } from './service/memory.ts'
import type { TranscriptService } from './service/transcript.ts'
import type {
  CoherenceMemoryListArgs,
  CoherenceMemoryListResult,
  CoherenceMemoryRow,
  CoherenceRecallArgs,
  CoherenceRecallResult,
  CoherenceStatsArgs,
  CoherenceStatsResult,
  CoherenceWorkspaceRow,
  CoherenceWorkspacesResult,
} from './types.ts'

export type {
  CoherenceIngestSource,
  CoherenceMemoryCounts,
  CoherenceMemoryLayer,
  CoherenceMemoryListArgs,
  CoherenceMemoryListResult,
  CoherenceMemoryRow,
  CoherenceRecallArgs,
  CoherenceRecallResult,
  CoherenceRecallRow,
  CoherenceStatsArgs,
  CoherenceStatsResult,
  CoherenceWorkspaceRow,
  CoherenceWorkspacesResult,
} from './types.ts'

/** Display text of one listed entry, per layer. */
function rowText(entry: MemoryEntry): string {
  switch (entry.layer) {
    case 'working':
      return entry.content
    case 'episodic':
      return entry.summary
    case 'semantic':
      return entry.claim
  }
}

/** Relevance timestamp of one listed entry, per layer. */
function rowAt(entry: MemoryEntry): number {
  switch (entry.layer) {
    case 'working':
      return entry.createdAt
    case 'episodic':
      return entry.startedAt
    case 'semantic':
      return entry.consolidatedAt ?? 0
  }
}

/** Semantic subject of one listed entry, when the layer carries one. */
function rowSubject(entry: MemoryEntry): string | undefined {
  return entry.layer === 'semantic' ? entry.subject : undefined
}

/** Tags of one listed entry: working and semantic carry tags, episodic does not. */
function rowTags(entry: MemoryEntry): readonly string[] {
  return entry.layer === 'episodic' ? [] : entry.tags
}

/** Map one stored entry onto its wire row. */
function toRow(entry: MemoryEntry): CoherenceMemoryRow {
  const subject = rowSubject(entry)
  return {
    layer: entry.layer,
    key: entry.key,
    text: rowText(entry),
    ...(subject === undefined ? {} : { subject }),
    agentType: entry.agentType ?? 'main',
    sessionId: entry.sessionId ?? '',
    importance: entry.layer === 'semantic' ? entry.confidence : entry.importance,
    state: entry.state,
    tags: rowTags(entry),
    at: rowAt(entry),
  }
}

/** The default row cap of one memory-list call. */
const LIST_LIMIT_DEFAULT = 200

/**
 * Read-only Remote projection of the coherence suite for the web Hub. The
 * memory and transcript services are resolved lazily so the gateway mounts on
 * any partial feature set and a disabled subsystem fails the calling RPC loud
 * instead of failing the whole plugin mount.
 */
export class CoherenceRemoteGateway extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'coherence')
  }

  /** The memory service; present when `features.memory` is enabled. */
  private get memory(): MemoryService {
    return this.ctx.get('memory') as MemoryService
  }

  /** The transcript service; present when `features.transcript` is enabled. */
  private get transcript(): TranscriptService {
    return this.ctx.get('transcript') as TranscriptService
  }

  /**
   * Summarize the suite: memory counts plus per-source ingest activity.
   * @param args - optional workspace shard selector (legacy when omitted).
   * @returns the point-in-time stats snapshot.
   */
  @Remote('stats')
  stats(args: CoherenceStatsArgs): CoherenceStatsResult {
    return {
      memory: this.memory.stats(args.workspaceId),
      ingest: this.transcript.sourceStatus(),
    }
  }

  /**
   * List stored memory entries, newest first.
   * @param args - optional layer, state, agent, limit, and workspace filters.
   * @returns the matching rows.
   */
  @Remote('listMemory')
  listMemory(args: CoherenceMemoryListArgs): CoherenceMemoryListResult {
    const filter = {
      ...(args.layer === undefined ? {} : { layer: args.layer }),
      ...(args.state === undefined ? {} : { state: args.state }),
      ...(args.agentType === undefined ? {} : { agentType: args.agentType }),
    }
    const rows = this.memory
      .list(filter, args.workspaceId)
      .map(toRow)
      .sort((a, b) => b.at - a.at)
    return { entries: rows.slice(0, args.limit ?? LIST_LIMIT_DEFAULT) }
  }

  /**
   * Recall memory by keyword across the three layers.
   * @param args - the query, optional token budget, and workspace selector.
   * @returns the ranked hits within the per-layer budget.
   */
  @Remote('recallMemory')
  recallMemory(args: CoherenceRecallArgs): CoherenceRecallResult {
    const result = this.memory.recall({
      query: args.query,
      ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
    })
    return {
      items: result.items.map((item) => {
        const subject = item.subject
        return {
          layer: item.layer,
          key: item.key,
          text: item.content,
          ...(subject === undefined ? {} : { subject }),
          agentType: item.agentType,
          sessionId: item.sessionId,
          importance: item.importance,
          state: item.state,
          score: item.score,
        }
      }),
      budgetUsed: result.budgetUsed,
      durationMs: result.durationMs,
    }
  }

  /**
   * List the registered workspaces the Hub's shard selector offers. Refreshes
   * the shard managers first so a freshly registered workspace opens its
   * shard here instead of reads silently falling back to legacy.
   * @returns one row per registered workspace (id + canonical path).
   */
  @Remote('listWorkspaces')
  async listWorkspaces(): Promise<CoherenceWorkspacesResult> {
    await this.transcript.refreshShards()
    const memory = this.ctx.get('memory')
    if (memory !== undefined) await memory.refreshShards()
    const registry = this.ctx.get('workspaceRegistry') as { list?: () => Array<{ id: string; path: string }> } | undefined
    const workspaces: CoherenceWorkspaceRow[] = (registry?.list?.() ?? []).map(ws => ({
      id: ws.id,
      path: ws.path,
    }))
    return { workspaces }
  }
}

export default CoherenceRemoteGateway
