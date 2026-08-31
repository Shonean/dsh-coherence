# `dsh-coherence`

[English](README.md) | 中文

一个 Cordis 插件，让 dsh 对它驱动的外部 agent——**claude code**、**opencode** 与 **codex**——拥有统一视角，通过四个方面：

1. **转录**（`transcript` 域 + `ctx.transcript`）——每个受管 agent 会话的归一化、可检索记录，从各工具自身的存储增量同步（Claude 的 `~/.claude/projects/**/*.jsonl`、opencode 的 `opencode.db`、codex 的 `~/.codex/*.sqlite`），并在摄取入口做凭据脱敏。
2. **三层记忆**（`memory` 域 + `ctx.memory`）——`working` / `episodic` / `semantic` 三层，预算化召回，以及一个受 CLS 启发的离线巩固：把 episode 重放成语义断言。
3. **代码库地图**（`codebase_map` 域 + `ctx.codebaseMap`）——持久化的 Explore 结果（文件夹、文件、符号），后续会话直接从地图回答结构问题，不再重复 Explore。
4. **工作日志**（`worklog` 域 + `ctx.worklog`）——共享方向文档、工作日志条目与跨 agent 交接；dsh 主 agent 与每个外部 agent 读写同一份方向，而不是复制提示词。

外部 agent 通过进程内 **MCP server**（`mcpServer` 特性）访问本套件：记忆、工作日志、代码库地图与转录检索以 MCP 工具形式通过 streamable-http 暴露，另有 `$DSH_HOME/mirror/` 与仓库 `.agents/` 目录下的人类可读**文件镜像**。Web UI 通过只读 **Typert Remote gateway**（`webGateway` 特性，默认开）访问：即 [Coherence Hub](../../client/ui-coherence-hub/README.zh.md) 页签读取的 `remote.coherence` face；套件还把自带的浏览器半（`ui-coherence`、`ui-coherence-hub`、`ui-coherence-inventory`）登记在自己的 `cordis.patch.yml` 名册里。

本套件建立在 dsh 既有的 `ctx.subagents` provider 之上——它不新增 subagent provider；它围绕 dsh 已有的 provider 管理记录与方向。

## 服务 API

| `ctx` 键 | 包内服务 | 职责 |
|---|---|---|
| `ctx.transcript` | `TranscriptService` | 归一化的外部 agent 会话记录 + 摄取游标 |
| `ctx.memory` | `MemoryService` | 三层记忆、预算化召回、状态机 |
| `ctx.codebaseMap` | `CodebaseMapService` | 文件夹 / 文件 / 符号地图 + explore 记录 |
| `ctx.worklog` | `WorklogService` | 方向文档、条目、交接 |

服务方法、schema 及其所属的域在 `src/` 中记录（`src/domain/*.ts` 是权威的持久化形状）。

## 配置

所有配置都是 schemastery `Config`（见 `src/config.ts`），因此每个可调项都能从 `cordis.yml` 或设置命名空间修改。bundle 补丁（`cordis.patch.yml`）以全部默认值激活本套件；常见覆盖如下：

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

## 分发

`dsh.bundle.patch` 指向 `cordis.patch.yml`。安装：

```sh
dsh plugin --profile <name> add dsh-coherence
```

配置文件档必须已挂载存储（`dsh-storage` / `dsh-storage-json` / `dsh-storage-domain`）；`web` profile 满足。

## 扩展点

- 本套件不在 `agent-loop` 上注册；它通过 `agent/*`、`subagent/*` 事件与 `domain/changed` 观察。
- 经本套件工具产生的模型可见写入会追加 `SessionEventMap` 成员（`memory/*`、`codebase-map/*`、`worklog/*`）；见 `src/session-events.ts`。
- 每个子系统都是挂在 `Config.features` 标志后的内部模块；日后拆分就是把对应模块移入新包，按 `docs/cookbook/adding-a-package.zh.md` 操作。

## 模型体验

### 记忆、代码库地图与工作日志工具

#### What the model sees

本套件在组合的工具注册表（`ctx.tools`）上注册十二个模型工具：记忆工具 `memory_write`、`memory_recall`、`memory_forget`、`memory_status` 与 `memory_consolidate`；代码库地图工具 `codebase_map_save`、`codebase_map_get` 与 `codebase_map_list`；以及工作日志工具 `worklog_get_direction`、`worklog_update_direction`、`worklog_log` 与 `worklog_list`。每个工具都会把模型可见的效果追加到调用 agent 的会话日志（`SessionEventMap` 的 `memory/*`、`codebase-map/*` 与 `worklog/*` 成员），并拒绝没有所属 agent 会话的调用者。工具只在组合了工具注册表时挂载（每个 web profile 都有）；它们调用的服务不受影响、始终可用。

#### Token effect

十二个工具 schema 随组合后的每个请求一起发送；定义在会话内是静态的，因此带来的是固定的 schema 开销而非按次变化的内容。

#### KV Cache effect

前缀稳定：工具 schema 每会话只注册一次、永不改变，因此位于可复用的请求前缀内，不会造成会话中途失效。

### 当前工作方向系统提示词段落

#### What the model sees

当工作日志特性挂载且组合了系统提示词服务时，本套件注册一个 `worklog:direction` 段（order 40），把当前共享方向渲染进主 agent 的系统提示词。没有活动方向时不输出任何内容。有活动方向与约束时的逐字形状：

##### 方向块

```markdown
## Current work direction
Build the dsh-coherence plugin.
Constraints: no new packages; reuse ctx.subagents
```

#### Token effect

存在活动方向时，每次请求一个短块：标题行加上目标与可选的 `Constraints:` 行；没有活动方向时不增加任何 token。

#### KV Cache effect

活动方向不变时前缀稳定：该块每次请求从工作日志存储重新读取，因此一次方向更新会重写本段，并使提示词前缀自该点之后失效。

## 已知限制与延后事项

- **外部 agent 的 MCP 访问要求套件进程正在运行**——streamable-http 传输从挂载本插件的 dsh 进程提供；外部 agent 必须把它们的 MCP 客户端指向该 URL。
- **codex 摄取是尽力而为的线程元数据**——连接器从 `state_5.sqlite` 读取线程元数据（标题、首条用户消息、目标、记忆）；完整 rollout 转录存储在 opaque 格式中，已延后。
- **转录新鲜度受摄取轮询间隔限制**——claude、opencode 与 codex 连接器按 `pollMs`（默认 60 秒）轮询各自的存储，因此一条记录可能落后源一个轮询周期；`ingestOpencode` 与 `ingestCodex` 默认关闭。
- **巩固逐字重放 episode**——`memory_consolidate` 用 episode 自身的摘要把每个活动 episode 蒸馏为语义断言（subject = agent）；基于 LLM 的 episode 摘要归纳是未来的增强。
- **凭据脱敏是正则式尽力而为**——`ingest.redactCredentials` 在摄取边界剥除已知的凭据形态（API key、bearer token、key=value 赋值），但无法保证每种非常规格式中的秘密都被捕获。
- **invariant 伴生不在 bundle 中**——`./invariant` 在 `invariants` 服务上注册，由测试环境或显式开启的 profile 挂载，符合仓库惯例。
