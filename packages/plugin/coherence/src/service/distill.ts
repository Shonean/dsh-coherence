/**
 * Rule-based episode distillation: turn ingested external-agent sessions into
 * episodic memories. Each session distills at most once (per shard), once its
 * stored message count reaches the threshold; the summary is rendered from a
 * byte-stable template so the downstream consolidation — which dedups semantic
 * claims by exact subject+claim text — never mints near-duplicate claims from
 * wording drift.
 * @module dsh-coherence/src/service/distill
 */

import type { Context } from '@deepseek-ai/cordis'
import { LEGACY_SHARD } from '../workspace-shards.ts'
import type { TranscriptMessage } from '../domain/transcript.ts'
import type { AgentType } from '../types.ts'
import type { MemoryService } from './memory.ts'
import type { TranscriptService } from './transcript.ts'

/** Default stored-message count a session needs before it distills. */
export const DISTILL_MIN_MESSAGES_DEFAULT = 4

/** Default cap, in code points, for the quoted first-request / last-reply excerpts. */
export const DISTILL_EXCERPT_CHARS_DEFAULT = 120

/** Distillation tuning for one connector. */
export interface DistillOptions {
  /** Stored messages a session needs before distilling (default {@link DISTILL_MIN_MESSAGES_DEFAULT}). */
  minMessages?: number
}

/** One session a poll touched, carrying the shard its batch landed in. */
export interface TouchedSession {
  readonly agentType: AgentType
  readonly sessionId: string
  /** Ingest-result shard (a workspace id or the {@link LEGACY_SHARD} marker). */
  readonly shard: string
}

/** Stable display label for the unregistered-directory case. */
const UNREGISTERED_DIRECTORY = 'an unregistered directory'

/** Flatten one message's text parts to a single string. */
function textOf(message: TranscriptMessage): string {
  return message.parts
    .filter(part => part.kind === 'text')
    .map(part => part.text)
    .join(' ')
}

/** Collapse whitespace, then clip to `maxChars` code points (CJK-safe). */
function clipText(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= maxChars ? flat : `${chars.slice(0, maxChars).join('')}…`
}

/** Render a quoted excerpt, or a fixed placeholder when the session has none. */
function quote(text: string | undefined): string {
  return text === undefined ? '(none)' : `"${clipText(text, DISTILL_EXCERPT_CHARS_DEFAULT)}"`
}

/**
 * Render one session's episode summary. Byte-stable by construction: every
 * input is either derived data (counts, ISO timestamps, the session id) or a
 * whitespace-collapsed, code-point-clipped excerpt, so the same session state
 * always renders the same string.
 * @param input - the session facts the template needs.
 * @returns the episodic summary text.
 */
export function renderSessionEpisode(input: {
  agentType: AgentType
  sessionId: string
  projectDir?: string
  messageCount: number
  startedAt: number
  endedAt: number
  firstUserText?: string
  lastAssistantText?: string
}): string {
  return [
    `External ${input.agentType} session ${input.sessionId} in ${input.projectDir ?? UNREGISTERED_DIRECTORY}:`,
    `${input.messageCount} messages from ${new Date(input.startedAt).toISOString()} to ${new Date(input.endedAt).toISOString()}.`,
    `First request: ${quote(input.firstUserText)}`,
    `Last reply: ${quote(input.lastAssistantText)}`,
  ].join(' ')
}

/**
 * Distill the sessions one poll touched. Each session distills at most once
 * per shard: a recorded distill state short-circuits, and a session below the
 * threshold is left for a later poll. The episode is written into the same
 * shard the session's transcript lives in.
 * @param touched - sessions the poll just ingested, with their shards.
 * @param transcript - the transcript service (records, messages, distill state).
 * @param memory - the memory service (episodic writes).
 * @param options - distillation tuning.
 * @returns how many episodic entries were written.
 */
export async function distillTouchedSessions(
  touched: readonly TouchedSession[],
  transcript: TranscriptService,
  memory: MemoryService,
  options: DistillOptions = {},
): Promise<number> {
  const minMessages = options.minMessages ?? DISTILL_MIN_MESSAGES_DEFAULT
  let written = 0
  for (const item of touched) {
    const workspaceId = item.shard === LEGACY_SHARD ? undefined : item.shard
    if (transcript.readDistill(item.agentType, item.sessionId, workspaceId) !== undefined) continue
    const session = transcript.session(item.agentType, item.sessionId, workspaceId)
    if (session === undefined || session.messageCount < minMessages) continue
    const messages = transcript.sessionMessages(item.agentType, item.sessionId, workspaceId)
    if (messages.length === 0) continue
    const firstUser = messages.find(message => message.role === 'user' && textOf(message).length > 0)
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant' && textOf(message).length > 0)
    await memory.write({
      layer: 'episodic',
      content: renderSessionEpisode({
        agentType: item.agentType,
        sessionId: item.sessionId,
        ...(session.projectDir === undefined ? {} : { projectDir: session.projectDir }),
        messageCount: session.messageCount,
        startedAt: messages[0]?.timestamp ?? session.createdAt,
        endedAt: messages.at(-1)?.timestamp ?? session.updatedAt,
        ...(firstUser === undefined ? {} : { firstUserText: textOf(firstUser) }),
        ...(lastAssistant === undefined ? {} : { lastAssistantText: textOf(lastAssistant) }),
      }),
      agentType: item.agentType,
      sessionId: item.sessionId,
    }, workspaceId)
    await transcript.writeDistill({
      agentType: item.agentType,
      sessionId: item.sessionId,
      messageCount: session.messageCount,
      lastMessageId: messages.at(-1)?.messageId ?? '',
      lastDistilledAt: Date.now(),
    }, workspaceId)
    written++
  }
  return written
}

/**
 * Connector-side distillation hook: run at the end of one poll over the
 * sessions that poll touched. A no-op when distillation is disabled
 * (`distill === undefined`), when the poll touched nothing, or when the
 * memory feature is not composed (`ctx.get('memory')` is `undefined`).
 * @param touched - sessions the poll just ingested, with their shards.
 * @param ctx - plugin context (the memory service is read optionally).
 * @param transcript - the transcript service.
 * @param distill - distillation options; `undefined` disables the hook.
 */
export async function distillAfterPoll(
  touched: readonly TouchedSession[],
  ctx: Context,
  transcript: TranscriptService,
  distill: DistillOptions | undefined,
): Promise<void> {
  if (distill === undefined || touched.length === 0) return
  const memory = ctx.get('memory')
  if (memory === undefined) return
  await distillTouchedSessions(touched, transcript, memory, distill)
}
