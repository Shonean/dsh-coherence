# dsh-client-ui-coherence-hub

[English](README.md) | 中文

coherence 的浏览器伴侣：**Coherence Hub** —— 与聊天、轨迹并列的顶层 `conversation.view` 会话视图页签，承载 [`dsh-coherence`](../../plugin/coherence/README.zh.md) 套件的数据面。[`ui-coherence`](../ui-coherence/README.zh.md) 的委派卡片 渲染转录里的单行，Hub 则是套件的完整信息表面。

## 分区

- **Agents** —— 外部 agent 接入状态（来自转录域的按来源消息量与最近活跃， 每个受管 agent 一张卡）+ 实时子 agent 血缘（运行/空闲圆点来自客户端会话 目录，每个目录子项一行，点击打开）。
- **Delegates** —— 从浏览器发起委派：表单（执行者下拉只列已注册且支持 可续聊的 provider、任务描述与正文）走 `subagent.startContinuable` RPC， 以当前会话为父会话启动子 agent 并跳转进去；每个 provider 一条静态路由 提示（lane 卡）；下方是当前会话可持续对话委派的实时列表（打开/停止）。 委派的发起与停止走 wire API，不经 Remote 网关。
- **Memory** —— 三层工作/情节/语义存储：顶部工作区分片选择器（legacy 「未归属」分片为默认，切换后所有读取携带 `workspaceId`）、分层计数、 按时间倒序的条目列表（层级、状态、agent、强度、标签）、经记忆服务预算 排序器的关键词检索。
- Map / Worklog / Transcripts —— 已声明的占位分区，后续版本落地。

## 数据通道

只读 Typert Remote gateway `remote.coherence`（`stats`、`listMemory`、 `recallMemory`、`listWorkspaces`），由 dsh-coherence 宿主半拥有、经 api-remotes 客户端组装挂载进浏览器——与 `remote.pluginInventory` 同一条缝。 每条记忆读取都接受可选 `workspaceId`：缺省读 legacy 分片； `listWorkspaces` 先刷新分片管理器，让刚注册的工作区从自己的分片出数据， 而不是静默回落 legacy。实时子 agent 血缘走客户端会话目录；委派的发起与 停止走 connection API 的 `subagent.providers`、`subagent.startContinuable` 与 `subagent.interrupt`。

## 挂载

与同族一致的纯 UI 插件：node 半（`src/index.ts`）是空 `apply`；浏览器半 经 `dsh.client` 声明从 `exports["./client"]` 出货。名册登记在 coherence 包自带的 `cordis.patch.yml`——安装 dsh-coherence 本身就是前端变更。

## 模型体验

无：Hub 在浏览器里渲染套件数据并驱动委派 wire API，本包不组装也不发送 任何 provider 请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓工作

- **分片读取层的回落是静默的** —— 分片尚未打开的工作区会读成 legacy 数据。 网关的 `listWorkspaces` 先刷新分片管理器（堵住常见竞态），UI 也把默认 选项标注为「未归属」；按分片显示打开状态的指示器暂缓。
- **委派要求 live 父会话** —— 发起表单要求当前会话的 Agent 处于 live （`subagent.prompt` 的同一契约）；没有「稍后启动」的持久队列。
- **路由提示是静态的** —— 按 provider 的引导是描述车道的 locale 文案； 没有动态的、由模型调用的引导面。
- **Map / Worklog / Transcripts 是占位** —— 分区已声明，但在其表面落地前 渲染同一占位块。

