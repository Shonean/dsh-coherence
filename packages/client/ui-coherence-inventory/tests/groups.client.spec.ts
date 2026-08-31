import { describe, expect, it } from 'vitest'
import { DEFAULT_GROUPS, groupEntries, isToggleableEntry, isToggleableGroup } from '../src/client/groups.ts'

const entry = (entryId: string, moduleName: string) => ({ entryId, moduleName })

describe('matchesPattern semantics (via groupEntries)', () => {
  it('claims by exact module name first, in declaration order', () => {
    const groups = groupEntries(
      [entry('a', 'dsh-coherence'), entry('b', 'dsh-client-ui-coherence')],
      [
        { id: 'coherence', label: 'Coherence', match: ['dsh-coherence', 'dsh-client-ui-coherence'] },
        { id: 'native', label: 'DSH', match: ['@deepseek-ai/*'] },
      ],
      'Other',
    )
    expect(groups.map(group => group.id)).toEqual(['coherence', 'native'])
    expect(groups[0]!.entries.map(item => item.entryId)).toEqual(['a', 'b'])
    expect(groups[1]!.entries).toEqual([])
  })

  it('matches prefix* and *substr* patterns and falls back to the other group', () => {
    const groups = groupEntries(
      [
        entry('falcon', 'file:///C:/tools/falcon-harness/dsh-plugin/lib/index.js'),
        entry('native', '@deepseek-ai/dsh-client-ui-jobs'),
        entry('caret', 'dsh-drop-caret'),
      ],
      [
        { id: 'falcon', label: 'FalconHarness', match: ['*falcon*'] },
        { id: 'native', label: 'DSH', match: ['@deepseek-ai/*'] },
      ],
      'Other',
    )
    const byId = new Map(groups.map(group => [group.id, group]))
    expect(byId.get('falcon')!.entries.map(item => item.entryId)).toEqual(['falcon'])
    expect(byId.get('native')!.entries.map(item => item.entryId)).toEqual(['native'])
    expect(byId.get('other')!.label).toBe('Other')
    expect(byId.get('other')!.entries.map(item => item.entryId)).toEqual(['caret'])
  })

  it('omits the fallback group when every entry is claimed', () => {
    const groups = groupEntries(
      [entry('a', 'dsh-coherence')],
      [{ id: 'coherence', label: 'Coherence', match: ['dsh-coherence'] }],
      'Other',
    )
    expect(groups.map(group => group.id)).toEqual(['coherence'])
  })

  it('keeps snapshot order inside each group and keeps empty declared groups in place', () => {
    const groups = groupEntries(
      [
        entry('a2', '@deepseek-ai/second'),
        entry('a1', '@deepseek-ai/first'),
        entry('z', 'dsh-coherence'),
      ],
      [
        { id: 'coherence', label: 'Coherence', match: ['dsh-coherence'] },
        { id: 'rest', label: 'Rest', match: ['@deepseek-ai/*'] },
      ],
      'Other',
    )
    expect(groups.map(group => group.id)).toEqual(['coherence', 'rest'])
    expect(groups[0]!.entries.map(item => item.entryId)).toEqual(['z'])
    expect(groups[1]!.entries.map(item => item.entryId)).toEqual(['a2', 'a1'])
  })

  it('applies the default declarations: coherence, falcon, then native DSH', () => {
    const groups = groupEntries(
      [
        entry('caret', 'dsh-drop-caret'),
        entry('falcon', 'file:///C:/tools/falcon-harness/dsh-plugin/lib/index.js'),
        entry('coherence-ui', 'dsh-client-ui-coherence'),
        entry('jobs', '@deepseek-ai/dsh-client-ui-jobs'),
        entry('coherence', 'dsh-coherence'),
      ],
      DEFAULT_GROUPS,
      '其他',
    )
    expect(groups.map(group => [group.id, group.entries.length])).toEqual([
      ['coherence', 2],
      ['falcon', 1],
      ['dsh-native', 1],
      ['other', 1],
    ])
    expect(groups[3]!.label).toBe('其他')
  })

  it('limits toggling to the declared groups and excludes the control surface', () => {
    expect(isToggleableGroup('coherence')).toBe(true)
    expect(isToggleableGroup('falcon')).toBe(true)
    expect(isToggleableGroup('dsh-native')).toBe(false)
    expect(isToggleableGroup('other')).toBe(false)
    expect(isToggleableEntry('dsh-coherence')).toBe(true)
    expect(isToggleableEntry('dsh-client-ui-coherence-inventory')).toBe(false)
  })
})
