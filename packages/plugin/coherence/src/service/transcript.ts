/**
 * Transcript service (`ctx.transcript`): the normalized, redacted, searchable
 * record of every managed external agent session. Ingest connectors read each
 * tool's own store and call {@link TranscriptService.ingest}; the service
 * dedups by stable message key, writes messages before the session record (the
 * package invariant's ordering), and tracks one incremental-sync cursor per
 * source.
 *
 * Sessions and messages are sharded per workspace (see `workspace-shards.ts`)
 * keyed by each session's `projectDir`; ingest cursors stay on the legacy
 * shard — they are global scan state (which external sources have been read),
 * not workspace records.
 * @module dsh-coherence/src/service/transcript
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  distillKey,
  messageKey,
  sessionKey,
  transcriptDomain,
  type AgentSessionRecord,
  type DistillState,
  type IngestCursor,
  type TranscriptMessage,
} from '../domain/transcript.ts'
import type { AgentSessionKey, AgentType, DistillStateKey, IngestCursorKey, TranscriptMessageKey } from '../types.ts'
import { pathIsWithin, WorkspaceShards, type WorkspaceShard } from '../workspace-shards.ts'
import { redactText, redactValue } from './redact.ts'

export { redactText, redactValue } from './redact.ts'

/** One connector-delivered batch of messages for one agent session. */
export interface IngestBatch {
  agentType: AgentType
  sessionId: string
  messages: TranscriptMessage[]
  /** Session metadata merged over the stored record (first write wins per key). */
  meta?: {
    title?: string
    projectDir?: string
    source?: AgentSessionRecord['source']
  }
}

/** Result of one ingest call. */
export interface IngestResult {
  agentType: AgentType
  sessionId: string
  messagesSeen: number
  /** Distinct messages whose keys were not already present. */
  messagesAdded: number
  /** Shard the batch landed in (workspace id or the legacy marker). */
  shard: string
}

/** Query filter over stored transcript messages. */
export interface TranscriptQuery {
  agentType?: AgentType
  sessionId?: string
  /** Case-insensitive keyword over text and reasoning parts. */
  query?: string
  limit?: number
  /** Shard to read; the legacy shard is read when omitted. */
  workspaceId?: string
}

/** Transcript service construction options. */
export interface TranscriptOptions {
  /** Redact credentials at the durable boundary (default true). */
  redactCredentials?: boolean
}

/** One agent source's stored-message activity across every shard. */
export interface IngestSourceStatus {
  readonly agentType: AgentType
  /** Messages stored for the agent across every workspace shard. */
  readonly messages: number
  /** Newest message timestamp, `0` when the source has none. */
  readonly lastActivityAt: number
}

/**
 * The per-shard table set. `cursors` is materialized in every shard for the
 * uniform spec, but ingest scan state lives only on the legacy shard's table;
 * `distills` instead is per-shard, sharded with the session it describes.
 */
export interface TranscriptTables {
  messages: KvTable<TranscriptMessageKey, TranscriptMessage>
  sessions: KvTable<AgentSessionKey, AgentSessionRecord>
  cursors: KvTable<IngestCursorKey, IngestCursor>
  distills: KvTable<DistillStateKey, DistillState>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    transcript: TranscriptService
  }
}

/** Whether a message's text parts contain the (lower-cased) needle. */
function messageHasText(message: TranscriptMessage, needle: string): boolean {
  for (const part of message.parts) {
    if ((part.kind === 'text' || part.kind === 'reasoning') && part.text.toLowerCase().includes(needle)) return true
  }
  return false
}

/** Move a workspace's sessions (and their message prefixes) out of the legacy shard. */
async function migrateIntoWorkspace(
  shard: WorkspaceShard<TranscriptTables>,
  legacyTables: TranscriptTables | undefined,
): Promise<void> {
  if (legacyTables === undefined || shard.path === undefined) return
  for (const [key, record] of legacyTables.sessions.entries()) {
    if (!pathIsWithin(record.projectDir, shard.path)) continue
    await shard.data.sessions.put(key, record)
    await legacyTables.sessions.delete(key)
    const prefix = `${record.agentType}:${record.sessionId}:`
    for (const [messageKey, message] of legacyTables.messages.entries()) {
      if (messageKey.startsWith(prefix)) {
        await shard.data.messages.put(messageKey, message)
        await legacyTables.messages.delete(messageKey)
      }
    }
  }
}

/** The transcript service. Open shards in `[Service.init]`; callers hold the `ctx.transcript` handle. */
export class TranscriptService extends Service {
  /** The storage domain form must be present before the domain opens. */
  static inject = ['storageDomain']

  private shards!: WorkspaceShards<TranscriptTables>
  private cursors!: KvTable<IngestCursorKey, IngestCursor>
  private readonly redact: boolean

  constructor(ctx: Context, options: TranscriptOptions = {}) {
    super(ctx, 'transcript')
    this.redact = options.redactCredentials ?? true
  }

  /** Open the legacy shard, the global cursors table, and every registered workspace's shard. */
  protected async [Service.init](): Promise<void> {
    this.shards = new WorkspaceShards<TranscriptTables>(this.ctx, 'transcript', {
      spec: domainName => ({ ...transcriptDomain, name: domainName }),
      open: (domain: Domain<typeof transcriptDomain>): TranscriptTables => ({
        messages: domain.table('messages'),
        sessions: domain.table('sessions'),
        cursors: domain.table('cursors'),
        distills: domain.table('distills'),
      }),
      bootstrap: migrateIntoWorkspace,
    })
    await this.shards.init()
    // Cursors are global scan state and live on the legacy domain unit.
    this.cursors = this.shards.legacy().cursors
  }

  /**
   * Re-open shards for workspaces that appeared since the last refresh.
   * @returns the workspaces newly sharded by this call.
   */
  refreshShards(): Promise<WorkspaceShard<TranscriptTables>[]> {
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
   * Ingest one batch of normalized messages. Redacts when enabled, writes every
   * message (idempotent by key), then writes the session record whose
   * `messageCount` equals the distinct messages stored under its prefix.
   * @param batch - messages plus session metadata for one agent session.
   * @param workspaceId - target shard; resolved from `batch.meta.projectDir`
   *   when omitted, falling back to the legacy shard.
   * @returns counts of the batch, the newly stored messages, and the shard used.
   */
  async ingest(batch: IngestBatch, workspaceId?: string): Promise<IngestResult> {
    const resolved = workspaceId ?? await this.shards.resolveId(batch.meta?.projectDir)
    const shard = this.shards.require(resolved)
    const tables = shard.data
    const key = sessionKey(batch.agentType, batch.sessionId)
    const existing = tables.sessions.get(key)
    let messagesAdded = 0
    for (const raw of batch.messages) {
      const message = this.redact ? { ...raw, parts: raw.parts.map(part => this.redactPart(part)) } : raw
      const messageKeyValue = messageKey(message.agentType, message.sessionId, message.messageId)
      if (tables.messages.get(messageKeyValue) === undefined) messagesAdded++
      await tables.messages.put(messageKeyValue, message)
    }
    const count = this.countMessages(tables, batch.agentType, batch.sessionId)
    const now = this.maxTimestamp(batch)
    await tables.sessions.put(key, {
      agentType: batch.agentType,
      sessionId: batch.sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      messageCount: count,
      title: batch.meta?.title ?? existing?.title,
      projectDir: batch.meta?.projectDir ?? existing?.projectDir,
      source: batch.meta?.source ?? existing?.source ?? { kind: 'db' },
    })
    return {
      agentType: batch.agentType,
      sessionId: batch.sessionId,
      messagesSeen: batch.messages.length,
      messagesAdded,
      shard: shard.workspaceId,
    }
  }

  /**
   * Query stored messages, newest first, capped by `limit`.
   * @param filter - optional agent, session, keyword, workspace, and limit filters.
   * @returns matching messages in descending timestamp order.
   */
  query(filter: TranscriptQuery = {}): TranscriptMessage[] {
    const limit = filter.limit ?? 200
    const needle = filter.query?.toLowerCase()
    const tables = this.shards.require(filter.workspaceId).data
    const matches: TranscriptMessage[] = []
    for (const [, message] of tables.messages.entries()) {
      if (filter.agentType !== undefined && message.agentType !== filter.agentType) continue
      if (filter.sessionId !== undefined && message.sessionId !== filter.sessionId) continue
      if (needle !== undefined && !messageHasText(message, needle)) continue
      matches.push(message)
    }
    matches.sort((a, b) => b.timestamp - a.timestamp)
    return matches.slice(0, limit)
  }

  /**
   * Aggregate per-agent message counts and last activity across every shard.
   * @returns one row per managed agent type, including the zero-activity ones.
   */
  sourceStatus(): IngestSourceStatus[] {
    const totals = new Map<AgentType, { messages: number; lastActivityAt: number }>()
    for (const agentType of ['main', 'claude-code', 'opencode', 'codex'] as const) {
      totals.set(agentType, { messages: 0, lastActivityAt: 0 })
    }
    for (const shard of this.shards.all()) {
      for (const [, message] of shard.data.messages.entries()) {
        const total = totals.get(message.agentType)
        if (total === undefined) continue
        total.messages++
        total.lastActivityAt = Math.max(total.lastActivityAt, message.timestamp)
      }
    }
    return [...totals].map(([agentType, total]) => ({
      agentType,
      messages: total.messages,
      lastActivityAt: total.lastActivityAt,
    }))
  }

  /**
   * Read the incremental-sync cursor of one source, if any.
   * @param path - the source path or database file.
   * @returns the stored cursor, or `undefined` when the source was never scanned.
   */
  readCursor(path: string): IngestCursor | undefined {
    return this.cursors.get(path as IngestCursorKey)
  }

  /**
   * Persist the incremental-sync cursor of one source (global scan state).
   * @param cursor - the cursor to store.
   */
  async writeCursor(cursor: IngestCursor): Promise<void> {
    await this.cursors.put(cursor.path as IngestCursorKey, cursor)
  }

  /**
   * Read one stored session record.
   * @param agentType - managed agent type.
   * @param sessionId - agent-native session id.
   * @param workspaceId - target shard; the legacy shard is read when omitted.
   * @returns the stored record, or `undefined` when the session is unknown.
   */
  session(agentType: AgentType, sessionId: string, workspaceId?: string): AgentSessionRecord | undefined {
    return this.shards.require(workspaceId).data.sessions.get(sessionKey(agentType, sessionId))
  }

  /**
   * Read one session's stored messages in ascending timestamp order.
   * @param agentType - managed agent type.
   * @param sessionId - agent-native session id.
   * @param workspaceId - target shard; the legacy shard is read when omitted.
   * @returns the stored messages, oldest first.
   */
  sessionMessages(agentType: AgentType, sessionId: string, workspaceId?: string): TranscriptMessage[] {
    const prefix = `${agentType}:${sessionId}:`
    const matches: TranscriptMessage[] = []
    for (const [key, message] of this.shards.require(workspaceId).data.messages.entries()) {
      if (key.startsWith(prefix)) matches.push(message)
    }
    return matches.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Read one session's episode-distillation state, if any.
   * @param agentType - managed agent type.
   * @param sessionId - agent-native session id.
   * @param workspaceId - target shard; the legacy shard is read when omitted.
   * @returns the stored state, or `undefined` when the session was never distilled.
   */
  readDistill(agentType: AgentType, sessionId: string, workspaceId?: string): DistillState | undefined {
    return this.shards.require(workspaceId).data.distills.get(distillKey(agentType, sessionId))
  }

  /**
   * Persist one session's episode-distillation state (per-shard, sharded with
   * the session it describes).
   * @param state - the state to store.
   * @param workspaceId - target shard; the legacy shard is used when omitted.
   */
  async writeDistill(state: DistillState, workspaceId?: string): Promise<void> {
    await this.shards.require(workspaceId).data.distills.put(distillKey(state.agentType, state.sessionId), state)
  }

  private countMessages(tables: TranscriptTables, agentType: AgentType, sessionId: string): number {
    const prefix = `${agentType}:${sessionId}:`
    let count = 0
    for (const key of tables.messages.keys()) if (key.startsWith(prefix)) count++
    return count
  }

  private maxTimestamp(batch: IngestBatch): number {
    if (batch.messages.length === 0) return 0
    return Math.max(...batch.messages.map(message => message.timestamp))
  }

  private redactPart(part: TranscriptMessage['parts'][number]): TranscriptMessage['parts'][number] {
    switch (part.kind) {
      case 'text':
      case 'reasoning':
        return { ...part, text: redactText(part.text) }
      case 'tool_call':
        return { ...part, arguments: redactValue(part.arguments) }
      case 'tool_result':
        return { ...part, content: redactValue(part.content) }
      case 'attachment':
        return part
      default:
        part satisfies never
        return part
    }
  }
}
