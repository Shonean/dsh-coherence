/**
 * Claude Code transcript ingest: polls every `~/.claude/projects` transcript
 * file, parses each JSONL event into a normalized transcript message, and feeds
 * batches to `ctx.transcript`. Incremental-sync cursors per file skip unchanged
 * files and resume after the last processed line. The `tool_use` Explore/Read
 * capture hook lands in the codebase-map milestone.
 * @module dsh-coherence/src/ingest/claude
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the timer service's `ctx.setInterval` augmentation into this
// program without a runtime import (the suite injects the timer service).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { ClaudeIngestConfig } from '../config.ts'
import type { FileNode, FolderNode } from '../domain/codebase-map.ts'
import type { IngestCursor, TranscriptMessage } from '../domain/transcript.ts'
import type { CodebaseMapService } from '../service/codebase-map.ts'
import { distillAfterPoll, type DistillOptions, type TouchedSession } from '../service/distill.ts'
import type { TranscriptService } from '../service/transcript.ts'
import type { IngestHandle } from './handle.ts'

/**
 * Claude project path on the current machine.
 * @param config - claude ingest settings.
 * @returns `config.home` when set, else `~/.claude`.
 */
export function resolveClaudeHome(config: ClaudeIngestConfig): string {
  return config.home ?? join(homedir(), '.claude')
}

/** Epoch milliseconds from a Claude event's `timestamp` field (number or ISO). */
function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/** Map one Claude content block (or a bare string) to transcript parts. */
function normalizeContent(content: unknown): TranscriptMessage['parts'] {
  if (typeof content === 'string') return content.length > 0 ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: TranscriptMessage['parts'] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as Record<string, unknown>
    switch (entry.type) {
      case 'text':
        if (typeof entry.text === 'string' && entry.text.length > 0) parts.push({ kind: 'text', text: entry.text })
        break
      case 'thinking':
        if (typeof entry.thinking === 'string' && entry.thinking.length > 0) {
          parts.push({ kind: 'reasoning', text: entry.thinking })
        }
        break
      case 'redacted_thinking':
        parts.push({ kind: 'reasoning', text: '[redacted thinking]' })
        break
      case 'tool_use':
        if (typeof entry.id === 'string' && typeof entry.name === 'string') {
          // `arguments` must be present even for input-less calls: the part
          // schema marks it nonoptional, and JSON persistence drops an
          // `undefined` key, which the domain would reject at open.
          parts.push({ kind: 'tool_call', id: entry.id, name: entry.name, arguments: entry.input ?? null })
        }
        break
      case 'tool_result':
        if (typeof entry.tool_use_id === 'string') {
          parts.push({ kind: 'tool_result', toolUseId: entry.tool_use_id, content: entry.content ?? null })
        }
        break
      default:
        break
    }
  }
  return parts
}

/**
 * One normalized Claude event, plus the event's workspace `cwd` (Claude Code
 * stamps every JSONL event with it) before it is folded into `projectDir`.
 */
export type NormalizedClaudeMessage = Omit<TranscriptMessage, 'agentType' | 'sessionId'> & { cwd?: string }

/**
 * Parse one JSONL line into a normalized transcript message. Non-message events
 * (`mode`, `permission-mode`, ...) and malformed lines return `null`.
 * @param line - one raw JSONL line.
 * @returns the normalized message without its agent/session identity, carrying
 *   the event's `cwd` for the connector to extract.
 */
export function normalizeClaudeEvent(line: string): NormalizedClaudeMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const event = raw as Record<string, unknown>
  if (event.type !== 'user' && event.type !== 'assistant') return null
  const message = event.message as Record<string, unknown> | undefined
  if (message === undefined || (message.role !== 'user' && message.role !== 'assistant')) return null
  let messageId = ''
  if (typeof event.uuid === 'string') messageId = event.uuid
  else if (typeof event.promptId === 'string') messageId = event.promptId
  if (messageId.length === 0) return null
  const parts = normalizeContent(message.content)
  if (parts.length === 0) return null
  return {
    messageId,
    parentId: typeof event.parentUuid === 'string' ? event.parentUuid : undefined,
    role: message.role,
    timestamp: toEpochMs(event.timestamp),
    parts,
    isSidechain: event.isSidechain === true ? true : undefined,
    meta: typeof message.model === 'string' ? { model: message.model } : undefined,
    ...(typeof event.cwd === 'string' && event.cwd.length > 0 ? { cwd: event.cwd } : {}),
  }
}

/** Every top-level `.jsonl` transcript file under `~/.claude/projects`. */
async function listTranscriptFiles(home: string): Promise<string[]> {
  const projectsDir = join(home, 'projects')
  let projectNames: string[]
  try {
    projectNames = (await readdir(projectsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const files: string[] = []
  for (const project of projectNames) {
    let fileNames: string[]
    try {
      fileNames = (await readdir(join(projectsDir, project), { withFileTypes: true }))
        .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
        .map(file => file.name)
    } catch {
      continue
    }
    for (const file of fileNames) files.push(join(projectsDir, project, file))
  }
  return files
}

/**
 * Read the new lines of one transcript file after `cursor`, parsing each into a
 * message. Unchanged files short-circuit without reading their content. The
 * batch's `projectDir` is the first non-empty event `cwd` (Claude Code writes
 * one workspace per file, so they agree).
 * @param file - absolute transcript path.
 * @param cursor - stored cursor, if any.
 * @returns the new messages (without their per-event `cwd`), the next cursor,
 *   and the extracted project directory when any event carried one.
 */
export async function readIncremental(
  file: string,
  cursor: IngestCursor | undefined,
): Promise<{ messages: Omit<TranscriptMessage, 'agentType' | 'sessionId'>[]; next: IngestCursor; projectDir?: string }> {
  const info = await stat(file)
  // `stat().mtimeMs` is a float (sub-ms precision); the cursor schema requires
  // integer milliseconds, so floor once and compare consistently.
  const lastModifiedMs = Math.floor(info.mtimeMs)
  if (cursor !== undefined && cursor.lastModifiedMs === lastModifiedMs) {
    return { messages: [], next: cursor }
  }
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n')
  const start = typeof cursor?.lastOffset === 'number' ? cursor.lastOffset : 0
  const messages: Omit<TranscriptMessage, 'agentType' | 'sessionId'>[] = []
  let projectDir: string | undefined
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]?.trim()
    if (line === undefined || line.length === 0) continue
    const message = normalizeClaudeEvent(line)
    if (message === null) continue
    const { cwd, ...rest } = message
    if (projectDir === undefined && cwd !== undefined) projectDir = cwd
    messages.push(rest)
  }
  const next: IngestCursor = {
    path: file,
    kind: 'file',
    lastOffset: lines.length,
    lastModifiedMs,
    lastEventAt: messages.at(-1)?.timestamp ?? cursor?.lastEventAt,
    scannedAt: Date.now(),
  }
  return { messages, next, ...(projectDir === undefined ? {} : { projectDir }) }
}

/**
 * File node kind guessed from a read path's extension and test markers. The
 * ingested transcript carries only the path, so the map classifies by shape;
 * the owning session can correct a mis-guess later via the map tools.
 * @param path - absolute path Claude Code read.
 * @returns the file node kind.
 */
export function fileKindForPath(path: string): FileNode['kind'] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['md', 'markdown', 'txt', 'rst', 'adoc'].includes(ext)) return 'docs'
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'config'].includes(ext)) return 'config'
  if (/(\.test\.|\.spec\.|tests[/\\]|__tests__[/\\])/.test(path)) return 'test'
  return 'source'
}

/**
 * Capture Claude Code exploration tool calls into the codebase map so a later
 * Claude Code session can skip re-exploring paths the suite already knows.
 * Idempotent: `upsert` overwrites a node by its path, so re-reading the same
 * file or re-searching the same directory refreshes `exploredAt` instead of
 * duplicating. `Explore`/`Glob`/`Grep` record directory nodes (and an explore
 * provenance row for `Explore`); `Read` records the file node.
 * @param messages - the batch just ingested from one transcript file.
 * @param codebaseMap - the codebase-map service.
 */
export async function captureExploration(
  messages: readonly Omit<TranscriptMessage, 'agentType' | 'sessionId'>[],
  codebaseMap: CodebaseMapService,
): Promise<void> {
  for (const message of messages) {
    const exploredAt = message.timestamp > 0 ? message.timestamp : Date.now()
    for (const part of message.parts) {
      if (part.kind !== 'tool_call') continue
      const args = (part.arguments ?? {}) as Record<string, unknown>
      switch (part.name) {
        case 'Explore': {
          const paths = typeof args.path === 'string'
            ? [args.path]
            : Array.isArray(args.paths)
              ? args.paths.filter((value): value is string => typeof value === 'string')
              : []
          for (const path of paths) {
            const node: FolderNode = {
              relativePath: path,
              name: basename(path) || path,
              purpose: 'Explored by Claude Code',
              keyFiles: [],
              summary: 'Directory explored by a Claude Code session.',
              exploredAt,
            }
            await codebaseMap.upsert(node)
            await codebaseMap.recordExplore({
              exploreId: part.id,
              at: exploredAt,
              rootPath: path,
              strategy: 'agent-explore',
              discovered: { folderCount: 0, fileCount: 0, symbolCount: 0 },
              summary: 'Claude Code Explore over this directory.',
            })
          }
          break
        }
        case 'Read': {
          if (typeof args.file_path === 'string') {
            const node: FileNode = {
              relativePath: args.file_path,
              kind: fileKindForPath(args.file_path),
              summary: 'Read by a Claude Code session.',
              keySymbols: [],
              responsibilities: [],
              exploredAt,
            }
            await codebaseMap.upsert(node)
          }
          break
        }
        case 'Glob':
        case 'Grep': {
          if (typeof args.path === 'string') {
            const node: FolderNode = {
              relativePath: args.path,
              name: basename(args.path) || args.path,
              purpose: 'Searched by Claude Code',
              keyFiles: [],
              summary: 'Directory searched by a Claude Code session.',
              exploredAt,
            }
            await codebaseMap.upsert(node)
          }
          break
        }
        default:
          break
      }
    }
  }
}

/**
 * Mount the Claude ingest poll. Runs once immediately, then every `pollMs`.
 * A missing `~/.claude` warns once (the source may simply not be installed)
 * and keeps the poll idle until the directory appears. Timers are lifecycle-
 * managed by the `timer` service.
 * @param ctx - plugin context carrying the timer service.
 * @param transcript - the transcript service.
 * @param config - Claude ingest settings.
 * @param codebaseMap - the codebase-map service, when exploration capture is
 * enabled (`features.codebaseMap` and `codebaseMap.autoCaptureExplore`).
 * @param distill - episode-distillation options; `undefined` disables distillation.
 * @returns the handle with the interval disposer and the immediate-poll entry.
 */
export function mountClaudeIngest(
  ctx: Context,
  transcript: TranscriptService,
  config: ClaudeIngestConfig,
  codebaseMap?: CodebaseMapService,
  distill?: DistillOptions,
): IngestHandle {
  const home = resolveClaudeHome(config)
  const projectsDir = join(home, 'projects')
  const logger = ctx.logger('dsh-coherence')
  let warnedMissing = false
  let running: Promise<void> | undefined
  const poll = async (): Promise<void> => {
    let missing = false
    try {
      await stat(projectsDir)
    } catch {
      missing = true
    }
    if (missing) {
      if (!warnedMissing) {
        warnedMissing = true
        logger.warn(`claude transcript home not found, ingest idle: ${projectsDir}`)
      }
      return
    }
    warnedMissing = false
    try {
      const touched: TouchedSession[] = []
      for (const file of await listTranscriptFiles(home)) {
        const cursor = transcript.readCursor(file)
        const { messages, next, projectDir } = await readIncremental(file, cursor)
        if (messages.length > 0) {
          const sessionId = basename(file, '.jsonl')
          const result = await transcript.ingest({
            agentType: 'claude-code',
            sessionId,
            messages: messages.map(message => ({ ...message, agentType: 'claude-code', sessionId })),
            meta: {
              source: { kind: 'file', path: file },
              ...(projectDir === undefined ? {} : { projectDir }),
            },
          })
          touched.push({ agentType: 'claude-code', sessionId, shard: result.shard })
          if (codebaseMap !== undefined) await captureExploration(messages, codebaseMap)
        }
        await transcript.writeCursor(next)
      }
      await distillAfterPoll(touched, ctx, transcript, distill)
    } catch (error) {
      logger.warn(`claude transcript ingest failed: ${error instanceof Error ? error.message : String(error)}`)
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
