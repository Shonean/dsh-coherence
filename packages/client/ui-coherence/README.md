# dsh-client-ui-coherence

English | [中文](README.zh.md)

Coherence browser companion: the dedicated **subagent delegation card** in the conversation transcript. The host's `tool-subagent` package registers the model-facing delegation tool under the wire name `subagent` (`config.toolName`, default `subagent`); this plugin claims that key in `ui-tool`'s keyed `tool.call.toolview` slot and renders one card per delegation, the way Claude Code shows subagent cards.

## What the card shows

- The model-authored 3–5 word task label (`args.description`) as the summary, with the `Subagent` / `子 agent` title and the agent glyph.
- Lifecycle state derived **only** from the frozen call/result slice: `running` (with the transcript shimmer), `ok`, `error` (first failure line replaces the label), `stopped` (interrupted, warning state). Replay stays stable regardless of what the live subagent catalog currently holds.
- A `background` / `后台` badge for detached runs — `run_in_background: true` in the args or a structured `background`/`continuable` result.
- A whole-row disclosure (Enter/Space operable) expanding into bounded `Delegation prompt` and `Result` cards with the exact durable text, plus the standard trajectory `Inspect` affordance.

The live subagent catalog — running children, continuation routing, the header lineage — stays owned by the external `@deepseek-ai/dsh-client-ui-subagent` package; this row is its per-call transcript surface. The host-side coordination plugin is [`dsh-coherence`](../../plugin/coherence/README.md).

## Mounting

Pure UI plugin: the node half (`src/index.ts`) is an empty `apply` so the plugin appears in the host Loader; the browser half ships via `exports["./client"]` and is discovered through the package.json `dsh.client` declaration. It is rostered in the coherence package's own `cordis.patch.yml` — installing `dsh-coherence` IS the frontend change.

The `/client` exports are the plugin body (`apply`/`inject`) only; the row component and dictionaries are internal to the registration effect.

## Model Experience

None, as the delegation card renders transcript rows in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Card state derives from the persisted slice only** — a replayed session keeps its recorded outcomes even when the live catalog has moved on; live running state is the Hub's and lineage's job, not the card's.
- **The card is terminal-state oriented** — expanded prompt/result text is the full raw content, so extremely large child outputs render unclipped in the expanded view.

