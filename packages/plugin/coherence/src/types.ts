/**
 * Shared vocabulary of the dsh-coherence plugin: the managed agent types, the
 * memory-state machine, and the branded cross-boundary ids this package owns.
 * @module dsh-coherence/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** The dsh main agent plus every external agent this suite manages. */
export type AgentType = 'main' | 'claude-code' | 'opencode' | 'codex'

/** Owner of a work direction document. */
export type DirectionOwner = AgentType | 'shared'

/** Memory-state machine; mirrors the CLS notion that recollection rewrites memory. */
export type MemoryState = 'active' | 'outdated' | 'contradicted' | 'tentative'

/** Transcript message role. */
export type TranscriptRole = 'user' | 'assistant' | 'system'

/** Ingest source medium. */
export type IngestSourceKind = 'file' | 'db' | 'export' | 'http'

/** Session-slot key in the transcript domain (`agentType:sessionId`). */
export type AgentSessionKey = Branded<'AgentSessionKey'>
/** Message key in the transcript domain (`agentType:sessionId:ts:role:index`). */
export type TranscriptMessageKey = Branded<'TranscriptMessageKey'>
/** Ingest-cursor key in the transcript domain (the source path). */
export type IngestCursorKey = Branded<'IngestCursorKey'>
/** Distill-state key in the transcript domain (`agentType:sessionId`). */
export type DistillStateKey = Branded<'DistillStateKey'>
/** Working-entry key in the memory domain. */
export type WorkingEntryKey = Branded<'WorkingEntryKey'>
/** Episodic-entry key in the memory domain. */
export type EpisodeKey = Branded<'EpisodeKey'>
/** Semantic-claim key in the memory domain. */
export type SemanticClaimKey = Branded<'SemanticClaimKey'>
/** Direction key in the worklog domain. */
export type DirectionKey = Branded<'DirectionKey'>
/** Worklog-entry key in the worklog domain. */
export type WorklogEntryKey = Branded<'WorklogEntryKey'>
/** Handoff key in the worklog domain. */
export type HandoffKey = Branded<'HandoffKey'>
/** Folder key in the codebase-map domain. */
export type FolderKey = Branded<'FolderKey'>
/** File key in the codebase-map domain. */
export type FileKey = Branded<'FileKey'>
/** Symbol key in the codebase-map domain. */
export type SymbolKey = Branded<'SymbolKey'>
/** Explore key in the codebase-map domain. */
export type ExploreKey = Branded<'ExploreKey'>

/** The three memory layers, repeated here as the wire vocabulary of the Remote gateway. */
export type CoherenceMemoryLayer = 'working' | 'episodic' | 'semantic'

/** One memory entry projected onto the wire, normalized across the three layers. */
export interface CoherenceMemoryRow {
  /** The layer the entry lives in. */
  readonly layer: CoherenceMemoryLayer
  /** Stable domain key of the entry. */
  readonly key: string
  /** Display text: working content, episodic summary, or semantic claim. */
  readonly text: string
  /** Semantic subject, present on semantic claims only. */
  readonly subject?: string
  /** The agent that produced the entry. */
  readonly agentType: AgentType
  /** The owning session id. */
  readonly sessionId: string
  /** Working/episodic importance, or semantic confidence. */
  readonly importance: number
  /** The entry's state-machine position. */
  readonly state: MemoryState
  /** Tags, working and semantic only. */
  readonly tags: readonly string[]
  /** Relevance timestamp (creation, episode start, or consolidation). */
  readonly at: number
}

/** Per-layer entry counts. */
export interface CoherenceMemoryCounts {
  readonly working: number
  readonly episodic: number
  readonly semantic: number
}

/** Arguments for one memory-list call. */
export interface CoherenceMemoryListArgs {
  /** Restrict to one layer; all layers when omitted. */
  readonly layer?: CoherenceMemoryLayer
  /** Restrict to one state; all states when omitted. */
  readonly state?: MemoryState
  /** Restrict to one agent; all agents when omitted. */
  readonly agentType?: AgentType
  /** Maximum rows returned, newest first (default 200). */
  readonly limit?: number
  /** Workspace shard to read; the legacy shard when omitted. */
  readonly workspaceId?: string
}

/** Result of one memory-list call. */
export interface CoherenceMemoryListResult {
  /** Matching rows, newest first. */
  readonly entries: readonly CoherenceMemoryRow[]
}

/** Arguments for one memory-recall call. */
export interface CoherenceRecallArgs {
  /** Keyword query scored against entry text. */
  readonly query: string
  /** Token budget across layers (default: the service's configured budget). */
  readonly maxTokens?: number
  /** Workspace shard to read; the legacy shard when omitted. */
  readonly workspaceId?: string
}

/** One ranked recall hit. */
export interface CoherenceRecallRow {
  readonly layer: CoherenceMemoryLayer
  readonly key: string
  readonly text: string
  readonly subject?: string
  readonly agentType: AgentType
  readonly sessionId: string
  readonly importance: number
  readonly state: MemoryState
  readonly score: number
}

/** Result of one memory-recall call. */
export interface CoherenceRecallResult {
  /** Ranked hits, best first, within the per-layer budget. */
  readonly items: readonly CoherenceRecallRow[]
  /** Tokens actually spent per layer. */
  readonly budgetUsed: { working: number; episodic: number; semantic: number }
  readonly durationMs: number
}

/** One ingest source's activity, as the transcript service reports it. */
export interface CoherenceIngestSource {
  readonly agentType: AgentType
  /** Messages stored for the agent across every workspace shard. */
  readonly messages: number
  /** Newest message timestamp, `0` when the source has none. */
  readonly lastActivityAt: number
}

/** One registered workspace the Hub can switch its shard reads to. */
export interface CoherenceWorkspaceRow {
  readonly id: string
  /** Canonical workspace path (the display label's tail segment). */
  readonly path: string
}

/** Result of the workspaces-list Remote. */
export interface CoherenceWorkspacesResult {
  readonly workspaces: readonly CoherenceWorkspaceRow[]
}

/** Arguments for one stats call. */
export interface CoherenceStatsArgs {
  /** Workspace shard to read; the legacy shard when omitted. */
  readonly workspaceId?: string
}

/** Point-in-time suite summary returned by the stats Remote. */
export interface CoherenceStatsResult {
  /** Per-layer memory entry counts. */
  readonly memory: CoherenceMemoryCounts
  /** Per-source ingest activity, one row per managed agent type. */
  readonly ingest: readonly CoherenceIngestSource[]
}
