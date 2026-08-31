/**
 * opencode transcript ingest: reads the opencode SQLite store
 * (`~/.local/share/opencode/opencode.db`) in read-only mode, normalizes
 * `message`/`part` rows into transcript messages, and feeds batches to
 * `ctx.transcript`. Incremental sync tracks the highest message rowid seen.
 * @module dsh-coherence/src/ingest/opencode
 */

import { access } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { OpencodeIngestConfig } from '../config.ts'
import type { IngestCursor, TranscriptMessage, TranscriptPart } from '../domain/transcript.ts'
import { distillAfterPoll, type DistillOptions, type TouchedSession } from '../service/distill.ts'
import type { IngestBatch, TranscriptService } from '../service/transcript.ts'
import type { IngestHandle } from './handle.ts'

/**
 * Default opencode SQLite path on the current machine.
 * @param config - opencode ingest settings.
 * @returns `config.dbPath` when set, else the platform share-dir path.
 */
export function resolveOpencodeDbPath(config: OpencodeIngestConfig): string {
  return config.dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/**
 * Normalize one opencode `part.data` JSON object into a transcript part.
 * Text, reasoning, and tool parts are kept; opaque parts are skipped.
 * @param data - the parsed part object.
 * @returns the transcript part, or `null` to skip.
 */
export function normalizeOpencodePart(data: Record<string, unknown>): TranscriptPart | null {
  switch (data.type) {
    case 'text':
      return typeof data.text === 'string' && data.text.length > 0 ? { kind: 'text', text: data.text } : null
    case 'reasoning':
      return typeof data.text === 'string' && data.text.length > 0 ? { kind: 'reasoning', text: data.text } : null
    case 'tool':
      // `arguments` must be present even when opencode stored no input: the
      // part schema marks it nonoptional, and JSON persistence drops an
      // `undefined` key, which would make the domain reject its own record
      // at open.
      return typeof data.tool === 'string'
        ? { kind: 'tool_call', id: typeof data.toolCallId === 'string' ? data.toolCallId : data.tool, name: data.tool, arguments: data.input ?? null }
        : null
    default:
      return null
  }
}

/**
 * Session-table columns that may carry the session's project directory, probed
 * in order — opencode's schema varies between versions.
 */
const DIRECTORY_COLUMN_CANDIDATES = ['directory', 'cwd', 'project_dir', 'project', 'worktree'] as const

/**
 * Read the new messages of the opencode store after `cursor`. When the store's
 * `session` table has a directory-like column, each batch carries it as
 * `meta.projectDir` (the shard key); a column this build does not have is
 * skipped and sessions fall back to the legacy shard.
 * @param dbPath - opencode SQLite path.
 * @param cursor - stored cursor, if any.
 * @returns one ingest batch per touched session plus the next cursor.
 */
export function readOpencodeIncremental(
  dbPath: string,
  cursor: IngestCursor | undefined,
): { batches: IngestBatch[]; next: IngestCursor } {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const start = typeof cursor?.lastRowId === 'number' ? cursor.lastRowId : 0
    const messageRows = db.prepare(
      'SELECT m.id, m.session_id, m.data, m.rowid AS rowid FROM message m WHERE m.rowid > ? ORDER BY m.rowid LIMIT 500',
    ).all(start)
    const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ?')
    const sessionColumns = (db.prepare('PRAGMA table_info(session)').all() as Array<{ name: unknown }>)
      .map(column => String(column.name))
    const directoryColumn = DIRECTORY_COLUMN_CANDIDATES.find(name => sessionColumns.includes(name))
    const sessionStmt = db.prepare(
      directoryColumn === undefined
        ? 'SELECT title FROM session WHERE id = ?'
        : `SELECT title, ${directoryColumn} AS directory FROM session WHERE id = ?`,
    )
    const bySession = new Map<string, TranscriptMessage[]>()
    const titles = new Map<string, string | undefined>()
    const directories = new Map<string, string | undefined>()
    let nextRowId = start
    for (const row of messageRows) {
      nextRowId = Math.max(nextRowId, Number(row.rowid))
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(row.data)) as Record<string, unknown>
      } catch {
        continue
      }
      const role = data.role === 'assistant' ? 'assistant' : data.role === 'system' ? 'system' : 'user'
      const timestamp = toEpochMs((data.time as { created?: unknown } | undefined)?.created ?? row.time_created)
      const parts: TranscriptPart[] = []
      for (const partRow of partStmt.all(String(row.id))) {
        try {
          const part = normalizeOpencodePart(JSON.parse(String(partRow.data)) as Record<string, unknown>)
          if (part !== null) parts.push(part)
        } catch {
          // skip malformed part
        }
      }
      if (parts.length === 0) continue
      const sessionId = String(row.session_id)
      const list = bySession.get(sessionId) ?? []
      list.push({
        agentType: 'opencode',
        sessionId,
        messageId: String(row.id),
        role,
        timestamp,
        parts,
      })
      bySession.set(sessionId, list)
      if (!titles.has(sessionId)) {
        const session = sessionStmt.get(String(row.session_id)) as
          | { title: string | null; directory?: unknown }
          | undefined
        titles.set(sessionId, session?.title ?? undefined)
        directories.set(
          sessionId,
          typeof session?.directory === 'string' && session.directory.length > 0 ? session.directory : undefined,
        )
      }
    }
    const batches: IngestBatch[] = [...bySession.entries()].map(([sessionId, messages]) => {
      const title = titles.get(sessionId)
      const directory = directories.get(sessionId)
      return {
        agentType: 'opencode',
        sessionId,
        messages,
        meta: {
          ...(title !== undefined ? { title } : {}),
          ...(directory !== undefined ? { projectDir: directory } : {}),
          source: { kind: 'db', path: dbPath },
        },
      }
    })
    const next: IngestCursor = {
      path: dbPath,
      kind: 'db',
      lastOffset: nextRowId,
      lastRowId: nextRowId,
      scannedAt: Date.now(),
    }
    return { batches, next }
  } finally {
    db.close()
  }
}

/**
 * Mount the opencode ingest poll. Runs once immediately, then every `pollMs`.
 * A missing store warns once (the tool may simply not be installed) and keeps
 * the poll idle until the file appears.
 * @param ctx - plugin context carrying the timer service.
 * @param transcript - the transcript service.
 * @param config - opencode ingest settings.
 * @param distill - episode-distillation options; `undefined` disables distillation.
 * @returns the handle with the interval disposer and the immediate-poll entry.
 */
export function mountOpencodeIngest(
  ctx: Context,
  transcript: TranscriptService,
  config: OpencodeIngestConfig,
  distill?: DistillOptions,
): IngestHandle {
  const dbPath = resolveOpencodeDbPath(config)
  const logger = ctx.logger('dsh-coherence')
  let warnedMissing = false
  let running: Promise<void> | undefined
  const poll = async (): Promise<void> => {
    let missing = false
    try {
      await access(dbPath)
    } catch {
      missing = true
    }
    if (missing) {
      if (!warnedMissing) {
        warnedMissing = true
        logger.warn(`opencode store not found, ingest idle: ${dbPath}`)
      }
      return
    }
    warnedMissing = false
    try {
      const cursor = transcript.readCursor(dbPath)
      const { batches, next } = readOpencodeIncremental(dbPath, cursor)
      const touched: TouchedSession[] = []
      for (const batch of batches) {
        const result = await transcript.ingest(batch)
        touched.push({ agentType: batch.agentType, sessionId: batch.sessionId, shard: result.shard })
      }
      await transcript.writeCursor(next)
      await distillAfterPoll(touched, ctx, transcript, distill)
    } catch (error) {
      logger.warn(`opencode ingest failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const runPoll = (): Promise<void> => {
    if (running !== undefined) return running
    running = poll().finally(() => { running = undefined })
    return running
  }
  void runPoll()
  const dispose = ctx.interval(() => { void runPoll() }, config.pollMs)
  return { dispose, pollNow: runPoll }
}
