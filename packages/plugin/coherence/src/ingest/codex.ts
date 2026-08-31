/**
 * codex ingest: reads the codex SQLite store (`~/.codex/state_5.sqlite`) in
 * read-only mode. codex keeps thread metadata in `threads` (including the first
 * user message) but stores full transcripts in opaque rollout files, so this
 * connector ingests thread records and — when `importMemories` is set — codex's
 * goals and memories into the worklog and semantic memory. Full rollout
 * transcripts are deferred until the rollout format is documented.
 * @module dsh-coherence/src/ingest/codex
 */

import { access } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CodexIngestConfig } from '../config.ts'
import type { IngestCursor, TranscriptMessage } from '../domain/transcript.ts'
import { distillAfterPoll, type DistillOptions, type TouchedSession } from '../service/distill.ts'
import type { IngestBatch, TranscriptService } from '../service/transcript.ts'
import type { IngestHandle } from './handle.ts'

/**
 * Default codex data root on the current machine.
 * @param config - codex ingest settings.
 * @returns `config.home` when set, else `~/.codex`.
 */
export function resolveCodexHome(config: CodexIngestConfig): string {
  return config.home ?? join(homedir(), '.codex')
}

/**
 * The state database holding `threads`.
 * @param home - the codex data root.
 * @returns the absolute path of `state_5.sqlite`.
 */
export function stateDbPath(home: string): string {
  return join(home, 'state_5.sqlite')
}

interface CodexThreadRow {
  id: string
  title: string | null
  first_user_message: string | null
  cwd: string | null
  created_at_ms: number | null
  updated_at_ms: number | null
}

/**
 * Read new codex thread records after `cursor`, optionally collecting goals and
 * memories for import.
 * @param home - codex data root.
 * @param cursor - stored cursor, if any.
 * @param importMemories - also read goals and memories.
 * @returns ingest batches, memory/worklog lines, and the next cursor.
 */
export function readCodexIncremental(
  home: string,
  cursor: IngestCursor | undefined,
  importMemories: boolean,
): { batches: IngestBatch[]; worklogLines: string[]; memoryContents: string[]; next: IngestCursor } {
  const path = stateDbPath(home)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const start = typeof cursor?.lastOffset === 'number' ? cursor.lastOffset : 0
    const threadRows = db.prepare(
      'SELECT id, title, first_user_message, cwd, created_at_ms, updated_at_ms FROM threads '
      + 'WHERE updated_at_ms > ? ORDER BY updated_at_ms',
    ).all(start) as unknown as CodexThreadRow[]
    const batches: IngestBatch[] = []
    let maxUpdated = start
    for (const thread of threadRows) {
      maxUpdated = Math.max(maxUpdated, thread.updated_at_ms ?? start)
      if (thread.first_user_message === null || thread.first_user_message.length === 0) continue
      const messages: TranscriptMessage[] = [{
        agentType: 'codex',
        sessionId: thread.id,
        messageId: `${thread.id}:0`,
        role: 'user',
        timestamp: thread.created_at_ms ?? Date.now(),
        parts: [{ kind: 'text', text: thread.first_user_message }],
      }]
      const meta: IngestBatch['meta'] = { source: { kind: 'db', path } }
      if (thread.title !== null && thread.title.length > 0) meta.title = thread.title
      if (thread.cwd !== null && thread.cwd.length > 0) meta.projectDir = thread.cwd
      batches.push({
        agentType: 'codex',
        sessionId: thread.id,
        messages,
        meta,
      })
    }
    const worklogLines: string[] = []
    const memoryContents: string[] = []
    if (importMemories) {
      try {
        const goals = db.prepare('SELECT thread_id, objective, status FROM thread_goals').all()
        for (const goal of goals as Array<{ thread_id: string; objective: string; status: string }>) {
          worklogLines.push(`codex goal (${goal.status}): ${goal.objective}`)
        }
        const memories = db.prepare('SELECT thread_id, raw_memory FROM stage1_outputs').all()
        for (const memory of memories as Array<{ thread_id: string; raw_memory: string }>) {
          memoryContents.push(memory.raw_memory)
        }
      } catch {
        // goals/memories tables are codex-version dependent; skip when absent
      }
    }
    const next: IngestCursor = {
      path,
      kind: 'db',
      lastOffset: maxUpdated,
      scannedAt: Date.now(),
    }
    return { batches, worklogLines, memoryContents, next }
  } finally {
    db.close()
  }
}

/**
 * Mount the codex ingest poll. Runs once immediately, then every `pollMs`.
 * A missing store warns once (the tool may simply not be installed) and keeps
 * the poll idle until the file appears.
 * @param ctx - plugin context carrying the timer service.
 * @param transcript - the transcript service.
 * @param config - codex ingest settings.
 * @param distill - episode-distillation options; `undefined` disables distillation.
 * @returns the handle with the interval disposer and the immediate-poll entry.
 */
export function mountCodexIngest(
  ctx: Context,
  transcript: TranscriptService,
  config: CodexIngestConfig,
  distill?: DistillOptions,
): IngestHandle {
  const home = resolveCodexHome(config)
  const dbPath = stateDbPath(home)
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
        logger.warn(`codex store not found, ingest idle: ${dbPath}`)
      }
      return
    }
    warnedMissing = false
    try {
      const cursor = transcript.readCursor(dbPath)
      const { batches, worklogLines, memoryContents, next } = readCodexIncremental(home, cursor, config.importMemories)
      const touched: TouchedSession[] = []
      for (const batch of batches) {
        const result = await transcript.ingest(batch)
        touched.push({ agentType: batch.agentType, sessionId: batch.sessionId, shard: result.shard })
      }
      const worklog = ctx.get('worklog')
      if (worklogLines.length > 0 && worklog !== undefined) {
        for (const line of worklogLines) await worklog.log({ text: line, kind: 'milestone', agentType: 'codex' })
      }
      const memory = ctx.get('memory')
      if (memoryContents.length > 0 && memory !== undefined) {
        for (const content of memoryContents) {
          await memory.write({ layer: 'semantic', subject: 'codex', content, importance: 0.4 })
        }
      }
      await transcript.writeCursor(next)
      await distillAfterPoll(touched, ctx, transcript, distill)
    } catch (error) {
      logger.warn(`codex ingest failed: ${error instanceof Error ? error.message : String(error)}`)
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
