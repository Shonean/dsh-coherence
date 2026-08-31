# dsh-coherence

English | [中文](README.zh.md)

**Coherence** is a Cordis plugin that keeps a long-running, multi-agent task coherent. When one task runs across many days and many agents — claude code, opencode, codex — each agent's context fragments: sessions drift, exploration repeats, direction forks, memories conflict. Coherence exists so those agents keep cooperating **inside the same workspace** without falling apart: one shared, searchable transcript of everything they did, three layers of memory to recall from, a map of the codebase they explored, and one worklog every agent reads and updates instead of duplicating prompts.

It is built on [dsh](https://github.com/deepseek-ai/deepseek-harness) — the DeepSeek Harness — and powered by [Cordis](https://github.com/cordiverse/cordis). It adds no subagent provider of its own: it manages the records and the direction around the subagent providers dsh already has.

## What it adds

1. **Transcript** (`transcript` + `ctx.transcript`) — a normalized, searchable record of every managed agent session, synced incrementally from each tool's own store (Claude, opencode, codex) with credential redaction.
2. **Three-layer memory** (`memory` + `ctx.memory`) — `working` / `episodic` / `semantic` layers with budgeted recall and offline consolidation that replays episodes into semantic claims.
3. **Codebase map** (`codebase_map` + `ctx.codebaseMap`) — persisted Explore outcomes (folders, files, symbols), so a later session answers structure questions from the map instead of re-exploring.
4. **Worklog** (`worklog` + `ctx.worklog`) — shared direction documents, work-log entries, and cross-agent handoffs; one direction instead of duplicated prompts.

External agents reach the suite through an in-process **MCP server** (streamable-http) and a human-readable **file mirror** under `$DSH_HOME/mirror/` and the repository `.agents/` directory. The web UI reaches it through a read-only **Typert Remote gateway** that feeds the Coherence Hub tab.

## Packages

| Package | What it is |
|---|---|
| [`dsh-coherence`](packages/plugin/coherence/README.md) | The host-side plugin: transcript, three-layer memory, codebase map, worklog, MCP server, web gateway. |
| [`dsh-client-ui-coherence`](packages/client/ui-coherence/README.md) | Browser half: the **subagent delegation card** in the conversation transcript. |
| [`dsh-client-ui-coherence-hub`](packages/client/ui-coherence-hub/README.md) | Browser half: the **Coherence Hub** conversation view. |
| [`dsh-client-ui-coherence-inventory`](packages/client/ui-coherence-inventory/README.md) | Browser half: the package-grouped **plugin inventory** tab in the web Plugins settings. |

Like Minecraft resource packs or mods, coherence ships as a **plugin pack**: one toggleable family — the host plugin plus its three browser halves — that you switch on and off as a unit, applying across the whole frontend. The plugin-inventory tab is the switch that turns the whole family back on.

## Install

From a dsh profile that already mounts storage (the `web` profile does):

```sh
dsh plugin --profile <name> add dsh-coherence
```

## Development

From a repository checkout:

```sh
pnpm install
pnpm run build                  # host + client bundles
pnpm run typecheck
pnpm run test
pnpm run lint
node tools/verify-deps.mjs      # pinned-dependency audit
pnpm run verify-docs            # bilingual README + doc-link gates
```

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
