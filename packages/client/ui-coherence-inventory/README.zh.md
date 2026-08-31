# dsh-client-ui-coherence-inventory

[English](README.md) | 中文

coherence 的浏览器半：Web 插件设置中的**按包分组的插件清单**页签 （设置 → 插件 → 插件包）。它经生成的 `remote.pluginInventory` 缝把宿主 已加载插件按所属包分组，并通过 `remote.pluginControl` 原地启停整个家族 （Loader 运行时卸载，无需重启内核）。coherence 家族（`coherence` + 三个 浏览器半）就是这样一个可启停的组；本页签自身被刻意设计为不可停用—— 它是把一切重新打开的钥匙。

## 页签内容

- 每个包组一张卡：组内插件、插件类型，以及原地停用/启用该家族的组头开关 （状态持久化在 `~/.dsh/cordis.patch.yml`）。
- 停用原地生效（Loader 运行时卸载，内核不重启），成功后整页刷新为变更后 的形态。

## 模型体验

无：页签在浏览器里渲染宿主插件清单，本包不接触任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓工作

- **以读为主的清单** —— 页签只提供按包分组的启停；单插件级启用、排序与 配置编辑仍由通用插件设置面承担。
- **分组形状是静态的** —— coherence 家族的分组规则写在 `src/client/groups.ts`；新增家族需要更新规则，而非自动发现分组。
