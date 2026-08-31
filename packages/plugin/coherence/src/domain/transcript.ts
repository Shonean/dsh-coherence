/**
 * Transcript domain: the unified, normalized record of every managed external
 * agent's sessions. `sessions` holds one slot per agent session, `messages`
 * one record per normalized message keyed by `agentType:sessionId:ts:role:index`,
 * and `cursors` the incremental-sync position of each source file or database.
 * @module dsh-coherence/src/domain/transcript
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentSessionKey, AgentType, DistillStateKey, IngestCursorKey, TranscriptMessageKey } from '../types.ts'

/** Global singleton: format and redaction revisions, monotonic. */
export const transcriptGlobalSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  redactionVersion: z.number().int().nonnegative(),
})

/** Source-of-record descriptor for one managed agent session. */
export const agentSessionRecordSchema = z.object({
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  sessionId: z.string().min(1),
  projectDir: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  source: z.object({
    kind: z.enum(['file', 'db', 'export', 'http']),
    path: z.string().optional(),
    lastEventId: z.string().optional(),
  }),
})

/** One content unit of a transcript message. */
export const transcriptPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('tool_call'), id: z.string(), name: z.string(), arguments: z.any() }),
  z.object({ kind: z.literal('tool_result'), toolUseId: z.string(), content: z.any() }),
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  z.object({ kind: z.literal('attachment'), uri: z.string(), mediaType: z.string().optional() }),
])

/** One normalized message in a managed agent session. */
export const transcriptMessageSchema = z.object({
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  parentId: z.string().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  timestamp: z.number().int().nonnegative(),
  parts: z.array(transcriptPartSchema),
  isSidechain: z.boolean().optional(),
  meta: z.any().optional(),
})

/** Incremental-sync cursor of one source file or database. */
export const ingestCursorSchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'db', 'export', 'http']),
  lastOffset: z.union([z.string(), z.number()]),
  lastEventAt: z.number().int().nonnegative().optional(),
  lastModifiedMs: z.number().int().nonnegative().optional(),
  lastRowId: z.number().int().nonnegative().optional(),
  scannedAt: z.number().int().nonnegative(),
})

/**
 * Episode-distillation state of one agent session: the session has been
 * distilled into one episodic memory once it is recorded here, so a later
 * poll of the same session never re-distills. Lives in the transcript domain,
 * so the state is sharded with the session it describes.
 */
export const distillStateSchema = z.object({
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  sessionId: z.string().min(1),
  /** Total messages stored for the session when it was distilled. */
  messageCount: z.number().int().nonnegative(),
  /** Message id of the last stored message at distillation time. */
  lastMessageId: z.string(),
  lastDistilledAt: z.number().int().nonnegative(),
})

/** The transcript domain declaration. */
export const transcriptDomain = defineDomain({
  name: 'transcript',
  version: 1,
  global: {
    schema: transcriptGlobalSchema,
    initial: { schemaVersion: 1, redactionVersion: 1 },
  },
  tables: {
    sessions: domainTable<AgentSessionKey, z.infer<typeof agentSessionRecordSchema>>(agentSessionRecordSchema),
    messages: domainTable<TranscriptMessageKey, z.infer<typeof transcriptMessageSchema>>(transcriptMessageSchema),
    cursors: domainTable<IngestCursorKey, z.infer<typeof ingestCursorSchema>>(ingestCursorSchema),
    distills: domainTable<DistillStateKey, z.infer<typeof distillStateSchema>>(distillStateSchema),
  },
})

/** Global singleton: format and redaction revisions, monotonic. */
export type TranscriptGlobal = z.infer<typeof transcriptGlobalSchema>
/** Source-of-record descriptor for one managed agent session. */
export type AgentSessionRecord = z.infer<typeof agentSessionRecordSchema>
/** One content unit of a transcript message. */
export type TranscriptPart = z.infer<typeof transcriptPartSchema>
/** One normalized message in a managed agent session. */
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>
/** Incremental-sync cursor of one source file or database. */
export type IngestCursor = z.infer<typeof ingestCursorSchema>
/** Episode-distillation state of one agent session. */
export type DistillState = z.infer<typeof distillStateSchema>

/**
 * Session-slot key (`agentType:sessionId`). The invariant recounts messages by
 * the `agentType:sessionId:` prefix, so every message key below must carry it.
 * @param agentType - managed agent type.
 * @param sessionId - agent-native session id.
 * @returns the branded session key.
 */
export function sessionKey(agentType: AgentType, sessionId: string): AgentSessionKey {
  return `${agentType}:${sessionId}` as AgentSessionKey
}

/**
 * Message key (`agentType:sessionId:messageId`). `messageId` is the stable
 * agent-native id (Claude event uuid, opencode `msg_*`, codex row id), so a
 * re-ingest of the same transcript overwrites in place and never duplicates.
 * @param agentType - managed agent type.
 * @param sessionId - agent-native session id.
 * @param messageId - stable agent-native message id.
 * @returns the branded message key.
 */
export function messageKey(agentType: AgentType, sessionId: string, messageId: string): TranscriptMessageKey {
  return `${agentType}:${sessionId}:${messageId}` as TranscriptMessageKey
}

/**
 * Distill-state key (`agentType:sessionId`), the same slot identity as the
 * session record: one distillation state per stored session.
 * @param agentType - managed agent type.
 * @param sessionId - agent-native session id.
 * @returns the branded distill-state key.
 */
export function distillKey(agentType: AgentType, sessionId: string): DistillStateKey {
  return `${agentType}:${sessionId}` as DistillStateKey
}
