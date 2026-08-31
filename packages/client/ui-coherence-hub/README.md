# dsh-client-ui-coherence-hub

English | [中文](README.zh.md)

Coherence browser companion: the **Coherence Hub**, a top-level conversation view tab (alongside Chat and Trajectory in the `conversation.view` slot ring) over the [`dsh-coherence`](../../plugin/coherence/README.md) suite's data. Where the delegation card in [`ui-coherence`](../ui-coherence/README.md) renders one transcript row, the Hub is the suite's full information surface.

## Sections

- **Agents** — external-agent ingest status (per-source message counts and last activity from the transcript domain, one card per managed agent) and the live subagent lineage (running/idle dots from the client's session catalog, one row per catalog child, opening the child on click).
- **Delegates** — start a delegation from the browser: a form (provider dropdown over the registered continuable providers, task label and body) that runs the `subagent.startContinuable` RPC against the current session and jumps into the child; a per-provider routing hint (the lane card, static); and the live list of the current session's continuable children with open/stop actions. Delegation start/interrupt ride the wire API, not the Remote gateway.
- **Memory** — the three-layer working / episodic / semantic store: a workspace shard selector (the legacy, unattributed shard is the default; switching threads `workspaceId` through every read), per-layer counts, a browsable newest-first row list (layer, state, agent, strength, tags), and keyword recall through the memory service's budgeted ranker.
- Map / Worklog / Transcripts — declared placeholder; the surfaces land in a later release.

## Data channel

Read-only Typert Remote gateway `remote.coherence` (`stats`, `listMemory`, `recallMemory`, `listWorkspaces`), owned by the dsh-coherence host half and mounted into the browser by the api-remotes client assembly — the same seam as `remote.pluginInventory`. Every memory read takes an optional `workspaceId`; `undefined` reads the legacy shard, and `listWorkspaces` refreshes the shard managers first so a freshly registered workspace is served from its own shard instead of silently falling back to legacy. The live subagent lineage stays on the client-side session catalog; delegation start/stop go through the connection API's `subagent.providers`, `subagent.startContinuable`, and `subagent.interrupt`.

## Mounting

Pure UI plugin like its siblings: the node half (`src/index.ts`) is an empty `apply`; the browser half ships via `exports["./client"]` under the `dsh.client` declaration. It is rostered in the coherence package's own `cordis.patch.yml` — installing dsh-coherence IS the frontend change.

## Model Experience

None, as the Hub renders suite data and drives the delegation wire API in the browser; nothing here assembles or sends a provider request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Shard fallback is silent at the read level** — a workspace whose shard has not opened yet reads as legacy data. The gateway's `listWorkspaces` refreshes the shard managers first (closing the common race), and the UI labels the default option "unattributed"; a per-shard open-state indicator is deferred.
- **Delegation needs a live parent** — the start form requires the current session's Agent to be live (the same contract `subagent.prompt` enforces); there is no durable "start later" queue.
- **Routing hints are static** — per-provider guidance is locale text describing lanes; no dynamic, model-called guidance surface exists.
- **Map / Worklog / Transcripts are placeholders** — the sections are declared but render the same placeholder block until their surfaces land.

