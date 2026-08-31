# dsh-client-ui-coherence

[English](README.md) | 中文

coherence 的浏览器伴侣：会话转录里专用的**子 agent 委派卡片**。宿主侧的 `tool-subagent` 包以连线名 `subagent`（`config.toolName`，默认 `subagent`） 注册面向模型的委派工具；本插件在 `ui-tool` 的键控 `tool.call.toolview` 槽中 认领该键，为每次委派渲染一张卡片，呈现方式与 Claude Code 的子 agent 卡片一致。

## 卡片内容

- 模型自拟的 3–5 词任务标签（`args.description`）作为摘要，前缀 `Subagent` / `子 agent` 标题与 agent 图标。
- 生命周期状态**仅**从冻结的调用/结果切片推导：`running`（带转录扫光）、 `ok`、`error`（首行错误取代标签）、`stopped`（被中止，警告态）。无论实时 子 agent 目录当前状态如何，回放保持稳定。
- 脱离式运行显示 `background` / `后台` 徽标——参数中 `run_in_background: true` 或结构化的 `background`/`continuable` 结果。
- 整行可展开（支持 Enter/Space），展开后为有界的「委派提示词」与「结果」卡片， 展示确切的持久化文本，并附带标准的轨迹 `Inspect` 入口。

实时子 agent 目录——运行中的子会话、续接路由、头部血缘——仍由外部包 `@deepseek-ai/dsh-client-ui-subagent` 拥有；本 行是它在转录中的逐调用表面。宿主侧协同插件是 [`dsh-coherence`](../../plugin/coherence/README.zh.md)。

## 挂载

纯 UI 插件：node 半（`src/index.ts`）是空的 `apply`，仅为让插件出现在宿主 Loader 中；浏览器半通过 `exports["./client"]` 出货，由 package.json 的 `dsh.client` 声明发现。名册登记在 coherence 包自带的 `cordis.patch.yml`——安装 `dsh-coherence` 本身就是前端变更。

`/client` 导出仅为插件体（`apply`/`inject`）；行组件与字典均为注册 effect 的 内部实现。

## 模型体验

无：委派卡片在浏览器里渲染转录行，本包不接触任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓工作

- **卡片状态只由持久化切片推导** —— 回放的会话保持其记录在案的结局，即使 实时目录早已翻篇；实时运行状态是 Hub 与血缘的职责，不是卡片的。
- **卡片面向终态** —— 展开后的提示词/结果文本是完整原样内容，超大子输出 在展开视图中不做裁剪渲染。

