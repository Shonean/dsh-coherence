/**
 * Worklog service (`ctx.worklog`): shared direction documents, work-log
 * entries, and cross-agent handoffs — one readable store that the dsh main
 * agent and every external agent update through the same tools, so the work
 * direction is a document, not a duplicated prompt.
 *
 * The worklog is sharded per workspace (see `workspace-shards.ts`): two
 * workspaces keep independent directions, logs, and handoffs. Every method
 * takes an optional `workspaceId`; callers without one use the legacy shard.
 * @module dsh-coherence/src/service/worklog
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  worklogDomain,
  type Direction,
  type Handoff,
  type WorklogEntry,
} from '../domain/worklog.ts'
import type { AgentType, DirectionOwner } from '../types.ts'
import { WorkspaceShards, type WorkspaceShard } from '../workspace-shards.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worklog: WorklogService
  }
}

/** Input to {@link WorklogService.updateDirection}. */
export interface DirectionUpdate {
  /** Existing direction id to update; omitted creates a new active direction. */
  directionId?: string
  title: string
  objective: string
  scope?: string
  constraints?: string[]
  priority?: number
  owner?: DirectionOwner
  status?: Direction['status']
  updatedBy?: AgentType
}

/** Input to {@link WorklogService.log}. */
export interface WorklogEntryInput {
  text: string
  kind?: WorklogEntry['kind']
  directionId?: string
  agentType?: AgentType
  sessionId?: string
  refs?: string[]
}

/** Input to {@link WorklogService.handoff}. */
export interface HandoffInput {
  from: AgentType
  to: AgentType
  summary: string
  pendingItems?: string[]
  linkedDirectionId?: string
}

/** List filter. */
export interface WorklogFilter {
  directionId?: string
  agentType?: AgentType
  kind?: WorklogEntry['kind']
}

/** The per-shard table set. */
export interface WorklogTables {
  directions: KvTable<string, Direction>
  entries: KvTable<string, WorklogEntry>
  handoffs: KvTable<string, Handoff>
}

function directionKey(directionId: string): string {
  return `d:${directionId}`
}

function entryKey(entryId: string): string {
  return `w:${entryId}`
}

function handoffKey(handoffId: string): string {
  return `h:${handoffId}`
}

/** The worklog service. Owns the worklog domain family. */
export class WorklogService extends Service {
  /** The storage domain form must be present before the domain opens. */
  static inject = ['storageDomain']

  private shards!: WorkspaceShards<WorklogTables>

  constructor(ctx: Context) {
    super(ctx, 'worklog')
  }

  /** Open the legacy shard plus every registered workspace's shard. */
  protected async [Service.init](): Promise<void> {
    this.shards = new WorkspaceShards<WorklogTables>(this.ctx, 'worklog', {
      spec: domainName => ({ ...worklogDomain, name: domainName }),
      open: (domain: Domain<typeof worklogDomain>): WorklogTables => ({
        directions: domain.table('directions'),
        entries: domain.table('entries'),
        handoffs: domain.table('handoffs'),
      }),
    })
    await this.shards.init()
  }

  /**
   * Re-open shards for workspaces that appeared since the last refresh.
   * @returns the workspaces newly sharded by this call.
   */
  refreshShards(): Promise<WorkspaceShard<WorklogTables>[]> {
    return this.shards.refresh()
  }

  /**
   * Resolve a project directory to a workspace shard id (realpath, async).
   * @param projectDir - the directory to resolve.
   * @returns the workspace id, or `undefined` when unregistered.
   */
  resolveWorkspaceId(projectDir?: string): Promise<string | undefined> {
    return this.shards.resolveId(projectDir)
  }

  /**
   * Synchronous best-effort resolution for sync contexts (prompt sections).
   * @param projectDir - the directory to resolve.
   * @returns the workspace id, or `undefined` when no registered root matches.
   */
  resolveWorkspaceIdSync(projectDir?: string): string | undefined {
    return this.shards.resolveIdSync(projectDir)
  }

  /**
   * The currently active direction (highest priority) of one shard, if any.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns the active direction or `undefined`.
   */
  getActiveDirection(workspaceId?: string): Direction | undefined {
    const actives = [...this.shards.require(workspaceId).data.directions.entries()]
      .map(([, direction]) => direction)
      .filter(direction => direction.status === 'active')
      .sort((a, b) => b.priority - a.priority)
    return actives[0]
  }

  /**
   * Every stored direction document of one shard.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns all directions in arbitrary order.
   */
  listDirections(workspaceId?: string): Direction[] {
    return [...this.shards.require(workspaceId).data.directions.entries()].map(([, direction]) => direction)
  }

  /**
   * Create or update a direction document. Creating a new direction marks every
   * other active direction `superseded` (one active direction at a time).
   * @param input - the direction to write.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns the direction id.
   */
  async updateDirection(input: DirectionUpdate, workspaceId?: string): Promise<string> {
    const tables = this.shards.require(workspaceId).data
    const now = Date.now()
    const updatedBy = input.updatedBy ?? 'main'
    if (input.directionId !== undefined) {
      const key = directionKey(input.directionId)
      const existing = tables.directions.get(key)
      if (existing === undefined) throw new Error(`worklog: no direction '${input.directionId}'`)
      const merged: Direction = {
        ...existing,
        title: input.title,
        objective: input.objective,
        scope: input.scope ?? existing.scope,
        constraints: input.constraints ?? existing.constraints,
        priority: input.priority ?? existing.priority,
        owner: input.owner ?? existing.owner,
        status: input.status ?? existing.status,
        updatedAt: now,
        updatedBy,
      }
      await tables.directions.put(key, merged)
      return input.directionId
    }
    for (const [key, existing] of tables.directions.entries()) {
      if (existing.status === 'active') {
        await tables.directions.put(key, { ...existing, status: 'superseded', updatedAt: now, updatedBy })
      }
    }
    const directionId = randomUUID()
    const direction: Direction = {
      directionId,
      title: input.title,
      status: 'active',
      priority: input.priority ?? 0.5,
      owner: input.owner ?? 'shared',
      scope: input.scope ?? '',
      objective: input.objective,
      constraints: input.constraints ?? [],
      linkedSessionIds: [],
      linkedMemoryKeys: [],
      updatedAt: now,
      updatedBy,
    }
    await tables.directions.put(directionKey(directionId), direction)
    return directionId
  }

  /**
   * Append one work-log entry.
   * @param input - the entry to log.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns the entry id.
   */
  async log(input: WorklogEntryInput, workspaceId?: string): Promise<string> {
    const entryId = randomUUID()
    const entry: WorklogEntry = {
      entryId,
      directionId: input.directionId,
      at: Date.now(),
      agentType: input.agentType,
      sessionId: input.sessionId,
      kind: input.kind ?? 'log',
      text: input.text,
      refs: input.refs ?? [],
    }
    await this.shards.require(workspaceId).data.entries.put(entryKey(entryId), entry)
    return entryId
  }

  /**
   * List work-log entries of one shard, newest first.
   * @param filter - optional direction, agent, and kind filters.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns matching entries.
   */
  listEntries(filter: WorklogFilter = {}, workspaceId?: string): WorklogEntry[] {
    const tables = this.shards.require(workspaceId).data
    const out: WorklogEntry[] = []
    for (const [, entry] of tables.entries.entries()) {
      if (filter.directionId !== undefined && entry.directionId !== filter.directionId) continue
      if (filter.agentType !== undefined && entry.agentType !== filter.agentType) continue
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue
      out.push(entry)
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /**
   * Record one cross-agent handoff and log a matching entry.
   * @param input - who passed work to whom.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   * @returns the handoff id.
   */
  async handoff(input: HandoffInput, workspaceId?: string): Promise<string> {
    const tables = this.shards.require(workspaceId).data
    const handoffId = randomUUID()
    const handoff: Handoff = {
      handoffId,
      from: input.from,
      to: input.to,
      at: Date.now(),
      summary: input.summary,
      pendingItems: input.pendingItems ?? [],
      linkedDirectionId: input.linkedDirectionId,
    }
    await tables.handoffs.put(handoffKey(handoffId), handoff)
    const entry: WorklogEntryInput = {
      text: `Handoff ${input.from} → ${input.to}: ${input.summary}`,
      kind: 'handoff',
      agentType: input.from,
    }
    if (input.linkedDirectionId !== undefined) entry.directionId = input.linkedDirectionId
    await this.log(entry, workspaceId)
    return handoffId
  }
}
