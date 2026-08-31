# dsh-client-ui-coherence-inventory

English | [中文](README.zh.md)

Coherence browser half: the **package-grouped plugin inventory** tab in the web Plugins settings (设置 → 插件 → 插件包). It groups the loaded Host plugins by owning package via the generated `remote.pluginInventory` face and toggles whole families in place through `remote.pluginControl` (Loader-unload without a kernel restart). The coherence family (`coherence` + its three browser halves) is one such toggleable group; this tab itself is deliberately untoggleable — it is the key that turns everything back on.

## What the tab shows

- One card per package group: its plugins, their kinds, and the group header switch that disables/enables the family in place (persisted in `~/.dsh/cordis.patch.yml`).
- Disabling is原地生效 (Loader runtime unload, no kernel restart) and the page reloads to the post-change shape on success.

## Model Experience

None, as the tab renders the Host plugin inventory in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Read-mostly inventory** — the tab surfaces package-grouped toggles only; per-plugin enablement, ordering, and config editing stay with the general plugin settings surfaces.
- **Group shape is static** — the coherence-family grouping rules live in `src/client/groups.ts`; new families need a rules update rather than discovering grouping automatically.
