# Showcase screenshots (synthetic sandbox)

Three composed screenshots of the dsh-coherence UI, rendered from
[`sandbox-demo.html`](sandbox-demo.html) — a self-contained synthetic sandbox
with clearly fictional demo data (project "acme-sandbox"). Use them for the
open-source showcase; they are demo content, not captures of a live session.

| File | What it shows |
|---|---|
| `coherence-hub.png` | The **Coherence Hub** view — external-agent ingest cards (claude code / opencode / codex), live subagent lineage, and the three-layer memory counts. |
| `coherence-memory.png` | The **Memory** section — workspace shard selector, keyword recall, and working / episodic / semantic rows. |
| `plugin-pack-inventory.png` | The package-grouped **plugin inventory** tab (Web Plugins → 插件包) — the coherence family as one toggleable plugin pack. |

## Re-render

The HTML is the source of truth; the PNGs are derived 2× renders (made with
the playwright `chromium` from the dev machine's playwright cache — the repo
intentionally carries no browser dependency). To regenerate, open
`sandbox-demo.html` in any browser and screenshot each `#view-*` section, or
replay the same headless-chromium render used to produce them.
