# `dsh-coherence`

English | [中文](README.zh.md)

One Cordis plugin that gives dsh a unified view across the external agents it drives — **claude code**, **opencode**, and **codex** — by adding four things:

1. **Transcript** (`transcript` domain + `ctx.transcript`) — a normalized, searchable record of every managed agent session, incrementally synced from each tool's own store (Claude's `~/.claude/projects/**/*.jsonl`, opencode's `opencode.db`, codex's `~/.codex/*.sqlite`) with credential redaction.
2. **Three-layer memory** (`memory` domain + `ctx.memory`) — `working` / `episodic` / `semantic` layers with budgeted recall and a CLS-inspired offline consolidation that replays episodes into semantic claims.
3. **Codebase map** (`codebase_map` domain + `ctx.codebaseMap`) — persisted Explore outcomes (folders, files, symbols), so a later session answers structure questions from the map instead of re-exploring.
4. **Worklog** (`worklog` domain + `ctx.worklog`) — shared direction documents, work-log entries, and cross-agent handoffs; the dsh main agent and every external agent read and update one direction instead of duplicating prompts.

External agents reach the suite through an in-process **MCP server** (the `mcpServer` feature): memory, worklog, codebase map, and transcript search exposed as MCP tools over streamable-http, plus a human-readable **file mirror** under `$DSH_HOME/mirror/` and the repository `.agents/` directory. The web UI reaches it through the read-only **Typert Remote gateway** (the `webGateway` feature, default on): the `remote.coherence` face the [Coherence Hub](../../client/ui-coherence-hub/README.md) tab reads; the suite also rosters its browser halves (`ui-coherence`, `ui-coherence-hub`, `ui-coherence-inventory`) in its own `cordis.patch.yml`.

The suite builds on dsh's existing `ctx.subagents` providers — it adds no subagent provider; it manages records and direction around the ones dsh already has.

## Service API

| `ctx` key | Package-provided service | Owns |
|---|---|---|
| `ctx.transcript` | `TranscriptService` | normalized external-agent session records + ingest cursors |
| `ctx.memory` | `MemoryService` | three-layer memory, budgeted recall, state machine |
| `ctx.codebaseMap` | `CodebaseMapService` | folder / file / symbol map + explore records |
| `ctx.worklog` | `WorklogService` | direction documents, entries, handoffs |

Service methods, schemas, and the domains they own are documented in `src/` (`src/domain/*.ts` are the authoritative durable shapes).

## Configuration

All configuration is schemastery `Config` (see `src/config.ts`), so every tunable is changeable from `cordis.yml` or a settings namespace. The bundle patch (`cordis.patch.yml`) activates the suite with all defaults; the common overrides are:

```yaml
- insert:
    - id: dsh-coherence
      name: 'dsh-coherence'
      config:
        features:
          mcpServer: true      # expose memory/worklog/codebase-map as MCP tools
          webGateway: true     # read-only Remote face for the web Coherence Hub
          ingestOpencode: true # sync opencode.db
          ingestCodex: true    # sync ~/.codex/*.sqlite
        mcpServer:
          transport: streamable-http
          port: 3140
```

## Distribution

`dsh.bundle.patch` points at `cordis.patch.yml`. Install with:

```sh
dsh plugin --profile <name> add dsh-coherence
```

The profile must already mount storage (`dsh-storage` / `dsh-storage-json` / `dsh-storage-domain`); the `web` profile does.

## Extension points

- The suite registers nothing on `agent-loop`; it observes through `agent/*` and `subagent/*` events and `domain/changed`.
- Model-visible writes through the suite's tools append `SessionEventMap` members (`memory/*`, `codebase-map/*`, `worklog/*`); see `src/session-events.ts`.
- Each subsystem is an internal module mounted behind a `Config.features` flag; splitting one out later means moving its module into a new package following `docs/cookbook/adding-a-package.md`.

## Model Experience

### Memory, codebase-map, and worklog tools

#### What the model sees

The suite registers twelve model tools on the composed tool registry (`ctx.tools`): the memory tools `memory_write`, `memory_recall`, `memory_forget`, `memory_status`, and `memory_consolidate`; the codebase-map tools `codebase_map_save`, `codebase_map_get`, and `codebase_map_list`; and the worklog tools `worklog_get_direction`, `worklog_update_direction`, `worklog_log`, and `worklog_list`. Each tool appends its model-visible effect to the calling agent's session log (`memory/*`, `codebase-map/*`, and `worklog/*` members of `SessionEventMap`) and rejects a caller without an owning agent session. The tools mount only when a tool registry is composed (every web profile has one); the services they call remain available regardless.

#### Token effect

The twelve tool schemas ship with every composed request the agent loop makes; the definitions are static for the session, so they contribute fixed schema overhead rather than per-call content.

#### KV Cache effect

Prefix-stable: the tool schemas are registered once per session and never change, so they sit inside the reusable request prefix and cause no mid-session invalidation.

### Current work direction system prompt section

#### What the model sees

When the worklog feature mounts with a composed system-prompt service, the suite registers a `worklog:direction` section (order 40) that renders the active shared direction into the main agent's system prompt. The section emits nothing when no active direction exists. The verbatim shape, with an active direction and constraints:

##### The direction block

```markdown
## Current work direction
Build the dsh-coherence plugin.
Constraints: no new packages; reuse ctx.subagents
```

#### Token effect

One short block per request while an active direction exists: the heading line plus the objective and the optional `Constraints:` line. No tokens are added when no direction is active.

#### KV Cache effect

Prefix-stable while the active direction is unchanged: the block is re-read from the worklog store per request, so a direction update rewrites this section and invalidates the prompt prefix from that point onward.

## Known Limitations and Deferred Work

- **External-agent MCP access requires the suite process to be running** — the streamable-http transport serves from the dsh process that mounts the plugin; external agents must point their MCP clients at its URL.
- **codex ingest is best-effort thread metadata** — the connector reads thread metadata (title, first user message, goals, memories) from `state_5.sqlite`; full rollout transcripts live in an opaque format and are deferred.
- **Transcript freshness is bounded by the ingest poll interval** — the claude, opencode, and codex connectors poll their stores on `pollMs` (default 60 s), so a record can lag one poll behind the source; `ingestOpencode` and `ingestCodex` default to off.
- **Consolidation replays episodes verbatim** — `memory_consolidate` distills each active episode into a semantic claim using the episode's own summary (subject = agent); LLM-based summarization of episodes is a future enhancement.
- **Credential redaction is regex-based best-effort** — `ingest.redactCredentials` strips known credential shapes (API keys, bearer tokens, key=value assignments) at the ingest boundary, but cannot guarantee every secret in an unusual format is caught.
- **Invariant companion is not part of the bundle** — `./invariant` registers on the `invariants` service and is mounted by test harnesses or a profile that opts in, matching the repository convention.
