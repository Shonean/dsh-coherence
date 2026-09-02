# dsh-coherence

[English](README.md) | 中文

**Coherence** 是一个 Cordis 插件，让跨多天、多 agent 的长任务保持连贯。当一个任务做了很多天、经过很多个 agent——claude code、opencode、codex——之后，各 agent 的上下文必然各自为政：会话漂移、探索重复、方向分叉、记忆冲突。Coherence 的目的就是让它们在**同一个工作区内**协同不出问题：一份共享、可检索的完整转录，三层可供召回的记忆，一张它们探索过的代码库地图，以及一份每个 agent 都读写同一份、而不是复制提示词的工作日志。

它建立在 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动。它不新增任何 subagent provider：它围绕 dsh 已有的 provider 管理记录与方向。

## 它带来什么

1. **转录**（`transcript` + `ctx.transcript`）——每个受管 agent 会话的归一化、可检索记录，从各工具自身存储（Claude、opencode、codex）增量同步，并在摄取入口做凭据脱敏。
2. **三层记忆**（`memory` + `ctx.memory`）——`working` / `episodic` / `semantic` 三层，预算化召回，以及把 episode 重放成语义断言的离线巩固。
3. **代码库地图**（`codebase_map` + `ctx.codebaseMap`）——持久化的 Explore 结果（文件夹、文件、符号），后续会话直接从地图回答结构问题，不再重复探索。
4. **工作日志**（`worklog` + `ctx.worklog`）——共享方向文档、工作日志条目与跨 agent 交接；一份方向，而不是复制的提示词。

外部 agent 通过进程内 **MCP server**（streamable-http）与 `$DSH_HOME/mirror/` 及仓库 `.agents/` 目录下的人类可读**文件镜像**访问本套件。Web UI 通过只读 **Typert Remote gateway** 访问，其数据面供给 Coherence Hub 页签。

## 包

| 包 | 是什么 |
|---|---|
| [`dsh-coherence`](packages/plugin/coherence/README.md) | 宿主侧插件：转录、三层记忆、代码库地图、工作日志、MCP server、web gateway。 |
| [`dsh-client-ui-coherence`](packages/client/ui-coherence/README.md) | 浏览器半：会话转录里专用的**子 agent 委派卡片**。 |
| [`dsh-client-ui-coherence-hub`](packages/client/ui-coherence-hub/README.md) | 浏览器半：**Coherence Hub** 会话视图。 |
| [`dsh-client-ui-coherence-inventory`](packages/client/ui-coherence-inventory/README.md) | 浏览器半：Web 插件设置里按包分组的**插件清单**页签。 |

像 Minecraft 资源包或 Mod 一样，coherence 以**插件包**的形式发布：一个可整体开关的家族——宿主插件加它的三个浏览器半——作用于整个前端。插件清单页签就是那个把它整体打开再关上的开关。

## 安装

在已挂载存储的 dsh profile 中（`web` profile 满足）：

```sh
dsh plugin --profile <name> add dsh-coherence
```

## 展示

**[Show Your Plugins! — dsh-coherence](https://github.com/deepseek-ai/deepseek-harness/discussions/5364)** —— 发布在 dsh 官方仓库的中英双语介绍帖，实拍截图见 [`docs/screenshots/`](docs/screenshots/captions.md)。

## 开发

从仓库检出开始：

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

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
