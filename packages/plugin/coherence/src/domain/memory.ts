/**
 * Memory domain: the three-layer working / episodic / semantic memory of the
 * suite, plus one singleton `state` row holding the recall budget and
 * consolidation timestamps. The four-state machine (`active` / `outdated` /
 * `contradicted` / `tentative`) models the CLS observation that recollection
 * rewrites memory: superseded records keep a `supersededBy` link so history
 * stays auditable.
 * @module dsh-coherence/src/domain/memory
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EpisodeKey, SemanticClaimKey, WorkingEntryKey } from '../types.ts'

/** Memory-state machine vocabulary. */
export const memoryStateSchema = z.enum(['active', 'outdated', 'contradicted', 'tentative'])

/** Working-memory entry: current, session-bound facts, observations, decisions, todos. */
export const workingEntrySchema = z.object({
  layer: z.literal('working'),
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  sessionId: z.string().min(1),
  kind: z.enum(['fact', 'observation', 'decision', 'todo']),
  content: z.string().min(1),
  importance: z.number().min(0).max(1),
  tags: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  source: z.object({
    agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
    sessionId: z.string(),
    messageId: z.string(),
  }).optional(),
  state: memoryStateSchema,
  supersededBy: z.string().optional(),
})

/** Episodic entry: one concrete episode distilled from a session or subagent run. */
export const episodicEntrySchema = z.object({
  layer: z.literal('episodic'),
  episodeId: z.string().min(1),
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']),
  sessionId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
  summary: z.string().min(1),
  events: z.array(z.object({
    ts: z.number().int().nonnegative(),
    kind: z.enum(['user', 'assistant', 'tool', 'decision']),
    ref: z.string().optional(),
  })),
  linkedTaskIds: z.array(z.string()),
  importance: z.number().min(0).max(1),
  state: memoryStateSchema,
})

/** Semantic claim: a consolidated, deduplicated long-term fact. */
export const semanticClaimSchema = z.object({
  layer: z.literal('semantic'),
  subject: z.string().min(1),
  claim: z.string().min(1),
  agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']).optional(),
  sessionId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  sourceCount: z.number().int().nonnegative(),
  sources: z.array(z.object({
    layer: z.enum(['episodic', 'semantic']),
    key: z.string(),
  })),
  tags: z.array(z.string()),
  state: memoryStateSchema,
  consolidatedAt: z.number().int().nonnegative().optional(),
  lastVerifiedAt: z.number().int().nonnegative().optional(),
})

/** Singleton state row: recall budget and consolidation bookkeeping. */
export const memoryRuntimeStateSchema = z.object({
  budget: z.object({
    working: z.number().min(0).max(1),
    episodic: z.number().min(0).max(1),
    semantic: z.number().min(0).max(1),
  }),
  lastConsolidationAt: z.number().int().nonnegative().optional(),
  nextConsolidationAt: z.number().int().nonnegative().optional(),
  workingTokens: z.number().int().nonnegative(),
})

/** The memory domain declaration. */
export const memoryDomain = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    working: domainTable<WorkingEntryKey, z.infer<typeof workingEntrySchema>>(workingEntrySchema),
    episodic: domainTable<EpisodeKey, z.infer<typeof episodicEntrySchema>>(episodicEntrySchema),
    semantic: domainTable<SemanticClaimKey, z.infer<typeof semanticClaimSchema>>(semanticClaimSchema),
    state: domainTable<'state', z.infer<typeof memoryRuntimeStateSchema>>(memoryRuntimeStateSchema),
  },
})

/** Memory-state machine vocabulary. */
export type MemoryStateValue = z.infer<typeof memoryStateSchema>
/** Working-memory entry: current, session-bound facts, observations, decisions, todos. */
export type WorkingEntry = z.infer<typeof workingEntrySchema>
/** Episodic entry: one concrete episode distilled from a session or subagent run. */
export type EpisodicEntry = z.infer<typeof episodicEntrySchema>
/** Semantic claim: a consolidated, deduplicated long-term fact. */
export type SemanticClaim = z.infer<typeof semanticClaimSchema>
/** Singleton state row: recall budget and consolidation bookkeeping. */
export type MemoryRuntimeState = z.infer<typeof memoryRuntimeStateSchema>
