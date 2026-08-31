/**
 * Plugin configuration: feature toggles plus every deployment-varying tunable.
 * All defaults live in the schemastery schema, so a bare `{}` activates a
 * sensible suite; absent containers still parse (inner field defaults apply).
 * The public `Config` interface is the honest post-parse shape; the schema is
 * cast to it the same way `dsh-mcp-client` does.
 * @module dsh-coherence/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Which subsystems of the suite mount. */
export interface FeaturesConfig {
  /** Normalized external-agent transcript records plus ingest cursors. */
  transcript: boolean
  /** Three-layer working/episodic/semantic memory and recall. */
  memory: boolean
  /** Persisted Explore outcomes (folders, files, symbols). */
  codebaseMap: boolean
  /** Shared direction documents, entries, and handoffs. */
  worklog: boolean
  /** Background episodic-to-semantic consolidation job. */
  consolidation: boolean
  /** Human-readable file mirror of the suite's domains. */
  mirror: boolean
  /** In-process MCP server exposing the suite to external agents. */
  mcpServer: boolean
  /** Typed Remote gateway the web Coherence Hub reads the suite through. */
  webGateway: boolean
  /** Poll `~/.claude/projects` transcripts. */
  ingestClaude: boolean
  /** Poll the opencode SQLite store. */
  ingestOpencode: boolean
  /** Poll the codex SQLite store. */
  ingestCodex: boolean
}

/** Claude-Code ingest settings. */
export interface ClaudeIngestConfig {
  /** `~/.claude` data root; defaults to the platform home. */
  home?: string
  /** Poll interval in milliseconds. */
  pollMs: number
  /** Feed captured transcript text into the working memory layer. */
  feedMemory: boolean
}

/** opencode ingest settings. */
export interface OpencodeIngestConfig {
  /** opencode SQLite path; defaults to the platform share dir. */
  dbPath?: string
  /** Poll interval in milliseconds. */
  pollMs: number
  /** Feed captured transcript text into the working memory layer. */
  feedMemory: boolean
}

/** codex ingest settings. */
export interface CodexIngestConfig {
  /** `~/.codex` data root; defaults to the platform home. */
  home?: string
  /** Poll interval in milliseconds. */
  pollMs: number
  /** Import codex goals and memories into the worklog and memory. */
  importMemories: boolean
}

/** Per-agent ingest settings. */
export interface IngestConfig {
  /** Strip known credential shapes at the ingest boundary. */
  redactCredentials: boolean
  /** Distill ingested external sessions into episodic memories. */
  distillSessions: boolean
  /** Stored messages a session needs before it distills. */
  distillMinMessages: number
  /** Claude Code ingest settings. */
  claude: ClaudeIngestConfig
  /** opencode ingest settings. */
  opencode: OpencodeIngestConfig
  /** codex ingest settings. */
  codex: CodexIngestConfig
}

/** Three-layer memory settings. */
export interface MemoryConfig {
  /** Total recall budget in tokens, split across layers. */
  recallMaxTokens: number
  /** Recall budget share per layer, summing to 1. */
  budget: {
    /** Working-layer recall share. */
    working: number
    /** Episodic-layer recall share. */
    episodic: number
    /** Semantic-layer recall share. */
    semantic: number
  }
  /** Auto-capture current-session facts into working memory at turn end. */
  autoCapture: boolean
  /** Consolidation starts once this many active episodes accumulate. */
  consolidationEpisodicThreshold: number
  /** Consolidation poll interval in milliseconds. */
  consolidationIntervalMs: number
}

/** Codebase-map settings. */
export interface CodebaseMapConfig {
  /** Repo roots the map tracks. */
  roots: string[]
  /** Record an Explore capture when the suite observes an Explore. */
  autoCaptureExplore: boolean
}

/** Worklog settings. */
export interface WorklogConfig {
  /** Default owner for new directions and entries. */
  defaultOwner: 'main' | 'claude-code' | 'opencode' | 'codex' | 'shared'
}

/** File-mirror settings. */
export interface MirrorConfig {
  /** Render the mirror files when the suite changes. */
  enabled: boolean
  /** Mirror root; defaults to `$DSH_HOME/mirror`. */
  root?: string
  /** Repository-relative mirror directory, e.g. `.agents`. */
  repoRelative: string
  /** Debounce window for mirror rewrites in milliseconds. */
  debounceMs: number
}

/** MCP-server settings. */
export interface McpServerConfig {
  /** MCP transport: streamable-http (default) or stdio. */
  transport: 'streamable-http' | 'stdio'
  /** HTTP listen port for streamable-http. */
  port: number
  /** HTTP path of the streamable-http endpoint. */
  path: string
  /** Whitelist of MCP tool names; empty serves every registered tool. */
  enabledTools: string[]
}

/** Full plugin config. */
export interface Config {
  /** Subsystem toggles for the suite. */
  features: FeaturesConfig
  /** Ingest settings for the three external agents. */
  ingest: IngestConfig
  /** Three-layer memory settings. */
  memory: MemoryConfig
  /** Codebase-map settings. */
  codebaseMap: CodebaseMapConfig
  /** Worklog settings. */
  worklog: WorklogConfig
  /** File-mirror settings. */
  mirror: MirrorConfig
  /** MCP-server settings. */
  mcpServer: McpServerConfig
}

const owner = z.union([
  z.const('main'),
  z.const('claude-code'),
  z.const('opencode'),
  z.const('codex'),
  z.const('shared'),
])

/** Schemastery config; absent containers parse with their field defaults. */
export const Config = z.object({
  features: z.object({
    transcript: z.boolean().default(true),
    memory: z.boolean().default(true),
    codebaseMap: z.boolean().default(true),
    worklog: z.boolean().default(true),
    consolidation: z.boolean().default(true),
    mirror: z.boolean().default(true),
    mcpServer: z.boolean().default(false),
    webGateway: z.boolean().default(true),
    ingestClaude: z.boolean().default(true),
    ingestOpencode: z.boolean().default(true),
    ingestCodex: z.boolean().default(true),
  }),
  ingest: z.object({
    redactCredentials: z.boolean().default(true),
    distillSessions: z.boolean().default(true),
    distillMinMessages: z.natural().default(4),
    claude: z.object({
      home: z.string(),
      pollMs: z.natural().default(60_000),
      feedMemory: z.boolean().default(false),
    }),
    opencode: z.object({
      dbPath: z.string(),
      pollMs: z.natural().default(60_000),
      feedMemory: z.boolean().default(false),
    }),
    codex: z.object({
      home: z.string(),
      pollMs: z.natural().default(60_000),
      importMemories: z.boolean().default(false),
    }),
  }),
  memory: z.object({
    recallMaxTokens: z.natural().default(4096),
    budget: z.object({
      working: z.number().min(0).max(1).default(0.45),
      episodic: z.number().min(0).max(1).default(0.30),
      semantic: z.number().min(0).max(1).default(0.25),
    }),
    autoCapture: z.boolean().default(false),
    consolidationEpisodicThreshold: z.natural().default(20),
    consolidationIntervalMs: z.natural().default(3_600_000),
  }),
  codebaseMap: z.object({
    roots: z.array(z.string()).default([]),
    autoCaptureExplore: z.boolean().default(true),
  }),
  worklog: z.object({
    defaultOwner: owner.default('main'),
  }),
  mirror: z.object({
    enabled: z.boolean().default(true),
    root: z.string(),
    repoRelative: z.string().default('.agents'),
    debounceMs: z.natural().default(500),
  }),
  mcpServer: z.object({
    transport: z.union([z.const('streamable-http'), z.const('stdio')]).default('streamable-http'),
    port: z.natural().default(3140),
    path: z.string().default('/mcp'),
    enabledTools: z.array(z.string()).default([]),
  }),
}) as unknown as z<Config>
