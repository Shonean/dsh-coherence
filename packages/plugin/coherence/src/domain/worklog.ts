/**
 * Worklog domain: the shared direction documents, work-log entries, and
 * cross-agent handoffs that let the dsh main agent and every external agent
 * work toward one direction through one readable store.
 * @module dsh-coherence/src/domain/worklog
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DirectionKey, HandoffKey, WorklogEntryKey } from '../types.ts'

/** One direction document: what work is being done, by whom, toward what. */
export const directionSchema = z.object({
  directionId: z.string().min(1),
  title: z.string(),
  status: z.enum(['active', 'paused', 'done', 'superseded']),
  priority: z.number().min(0).max(1),
  owner: z.enum(['main', 'claude-code', 'opencode', 'codex', 'shared']),
  scope: z.string(),
  objective: z.string().min(1),
  constraints: z.array(z.string()),
  linkedSessionIds: z.array(z.string()),
  linkedMemoryKeys: z.array(z.string()),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.enum(['main', 'claude-code', 'opencode', 'codex']),
})

/** One work-log entry: a log line, milestone, decision, handoff, or explore record. */
export const worklogEntrySchema = z.object({
  entryId: z.string().min(1),
  directionId: z.string().optional(),
  at: z.number().int().nonnegative(),
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']).optional(),
  sessionId: z.string().optional(),
  kind: z.enum(['log', 'milestone', 'decision', 'handoff', 'explore']),
  text: z.string().min(1),
  refs: z.array(z.string()),
})

/** One cross-agent handoff: who passed work to whom, with pending items. */
export const handoffSchema = z.object({
  handoffId: z.string().min(1),
  from: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  to: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  at: z.number().int().nonnegative(),
  summary: z.string(),
  pendingItems: z.array(z.string()),
  linkedDirectionId: z.string().optional(),
})

/** The worklog domain declaration. */
export const worklogDomain = defineDomain({
  name: 'worklog',
  version: 1,
  tables: {
    directions: domainTable<DirectionKey, z.infer<typeof directionSchema>>(directionSchema),
    entries: domainTable<WorklogEntryKey, z.infer<typeof worklogEntrySchema>>(worklogEntrySchema),
    handoffs: domainTable<HandoffKey, z.infer<typeof handoffSchema>>(handoffSchema),
  },
})

/** One direction document: what work is being done, by whom, toward what. */
export type Direction = z.infer<typeof directionSchema>
/** One work-log entry: a log line, milestone, decision, handoff, or explore record. */
export type WorklogEntry = z.infer<typeof worklogEntrySchema>
/** One cross-agent handoff: who passed work to whom, with pending items. */
export type Handoff = z.infer<typeof handoffSchema>
