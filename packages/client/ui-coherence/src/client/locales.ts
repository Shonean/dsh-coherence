/** `coherence` namespace dictionaries for the dedicated subagent tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'coherence'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '子 agent',
  'row.running': '子 agent 运行中',
  'row.failed': '子 agent 失败',
  'row.stopped': '子 agent 已中止',
  'row.background': '后台',
  'row.prompt': '委派提示词',
  'row.result': '结果',
} satisfies Record<string, string>

/** The coherence namespace key union. */
export type CoherenceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Subagent',
  'row.running': 'Subagent running',
  'row.failed': 'Subagent failed',
  'row.stopped': 'Subagent stopped',
  'row.background': 'background',
  'row.prompt': 'Delegation prompt',
  'row.result': 'Result',
} satisfies Record<CoherenceKey, string>
