# Show Your Plugins! — dsh-coherence

_Draft (2026-08-31). Bilingual post for the dsh plugin showcase. Companion screenshots: see `docs/screenshots/` (C1)._

---

## English

> **Show Your Plugins!** — a thread where dsh plugin authors show what they built. Today: **dsh-coherence**.

**dsh-coherence** is one Cordis plugin that keeps a long-running, multi-agent task coherent. When one task runs across many days and many agents — claude code, opencode, codex — each agent's context fragments: sessions drift, exploration repeats, direction forks, memories conflict. Coherence exists so those agents keep cooperating **inside the same workspace** without falling apart. It adds no subagent provider of its own: it manages the records and the direction around the subagent providers dsh already has.

What it brings:

1. **Transcript** — a normalized, searchable record of every managed agent session, synced from each tool's own store (Claude, opencode, codex) with credential redaction.
2. **Three-layer memory** — `working` / `episodic` / `semantic`, with budgeted recall and offline consolidation that replays episodes into semantic claims.
3. **Codebase map** — persisted Explore outcomes (folders, files, symbols), so a later session answers structure questions from the map instead of re-exploring.
4. **Worklog** — one shared direction every agent reads and updates, instead of duplicated prompts.

External agents reach it over an in-process **MCP server** (streamable-http) plus a human-readable **file mirror**; the web UI reaches it through a read-only **Typert Remote gateway** that feeds the **Coherence Hub** tab.

Like Minecraft resource packs or mods, coherence ships as a **plugin pack**: one toggleable family — the host plugin plus its three browser halves — that you switch on and off as a unit from the Web Plugins settings.

```
dsh plugin --profile <name> add dsh-coherence
```

**Now it's your turn** — what plugin have *you* built on dsh? Reply with a one-liner, a screenshot, or a repo link. Show your plugins!

---

## 中文

> **Show Your Plugins!** —— 一个让 dsh 插件作者展示自己作品的帖子。今天出场:**dsh-coherence**。

**dsh-coherence** 是一个 Cordis 插件，让跨多天、多 agent 的长任务保持连贯。当一个任务做了很多天、经过很多个 agent——claude code、opencode、codex——之后，各 agent 的上下文必然各自为政：会话漂移、探索重复、方向分叉、记忆冲突。Coherence 的目的就是让它们在**同一个工作区内**协同不出问题。它不新增任何 subagent provider：它围绕 dsh 已有的 provider 管理记录与方向。

它带来什么：

1. **转录** —— 每个受管 agent 会话的归一化、可检索记录，从各工具自身存储（Claude、opencode、codex）增量同步，并在摄取入口做凭据脱敏。
2. **三层记忆** —— `working` / `episodic` / `semantic` 三层，预算化召回，以及把 episode 重放成语义断言的离线巩固。
3. **代码库地图** —— 持久化的 Explore 结果（文件夹、文件、符号），后续会话直接从地图回答结构问题，不再重复探索。
4. **工作日志** —— 一份每个 agent 都读写同一份、而不是复制提示词的共享方向。

外部 agent 通过进程内 **MCP server**（streamable-http）与人类可读的**文件镜像**访问本套件；Web UI 通过只读 **Typert Remote gateway** 访问，其数据面供给 **Coherence Hub** 页签。

像 Minecraft 资源包或 Mod 一样，coherence 以**插件包**的形式发布：一个可整体开关的家族——宿主插件加它的三个浏览器半——在 Web 插件设置里一键开关。

```
dsh plugin --profile <name> add dsh-coherence
```

**轮到你了** —— 你在 dsh 上做了什么插件？一句话、一张截图或一个仓库链接都可以。Show your plugins!
