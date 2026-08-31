/** Copy dictionaries for the package-groups Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '插件包',
  loading: '正在读取插件…',
  error: '暂时无法读取插件。',
  retry: '重试',
  hint: '按插件包分组展示当前加载的插件；单插件详情见"插件列表"页签。',
  other: '其他',
  empty: '暂无插件。',
  enabledTag: '已启用',
  disabledTag: '已停用',
  enable: '启用',
  disable: '停用',
  toggling: '切换中…',
  toggleFailed: '切换失败：',
  unobserved: '未挂载',
  pending: '等待依赖',
  loadingPhase: '加载中',
  active: '已挂载',
  failed: '挂载失败',
  unloading: '卸载中',
} satisfies Record<string, string>

/** Package-groups locale key union. */
export type PackageGroupsLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Packages',
  loading: 'Reading plugins…',
  error: 'Plugins are temporarily unavailable.',
  retry: 'Retry',
  hint: 'Currently loaded plugins grouped by plugin package; per-plugin details live in the Plugin list tab.',
  other: 'Other',
  empty: 'No plugins are available.',
  enabledTag: 'Enabled',
  disabledTag: 'Disabled',
  enable: 'Enable',
  disable: 'Disable',
  toggling: 'Toggling…',
  toggleFailed: 'Toggle failed:',
  unobserved: 'Not mounted',
  pending: 'Waiting for dependencies',
  loadingPhase: 'Loading',
  active: 'Mounted',
  failed: 'Mount failed',
  unloading: 'Unloading',
} satisfies Record<PackageGroupsLocaleKey, string>
