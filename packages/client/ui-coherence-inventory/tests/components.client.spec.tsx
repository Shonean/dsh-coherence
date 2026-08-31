// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PackageGroupsSettingsTab } from '../src/client/PackageGroupsSettingsTab.tsx'
import type {
  PackageGroupsSettingsTabInjected,
  PackageGroupsSettingsTabProps,
} from '../src/client/PackageGroupsSettingsTab.tsx'
import { en, type PackageGroupsLocaleKey } from '../src/client/locales.ts'
import type { PluginControlSetDisabledResult } from '@deepseek-ai/dsh-api-remotes/client'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PackageGroupsSettingsTabInjected['list']>>
const t = ((key: PackageGroupsLocaleKey): string => en[key]) as PackageGroupsSettingsTabProps['t']

function props(
  list: PackageGroupsSettingsTabInjected['list'],
  over: Partial<PackageGroupsSettingsTabInjected> = {},
): PackageGroupsSettingsTabProps {
  return {
    t,
    list,
    setDisabled: vi.fn(async () => ({ results: [] })),
    reload: vi.fn(),
    ...over,
  } as PackageGroupsSettingsTabProps
}

const SNAPSHOT = {
  entries: [
    { entryId: 'jobs', moduleName: '@deepseek-ai/dsh-client-ui-jobs', enabled: true, fiberPhase: 'active' },
    { entryId: 'coherence', moduleName: 'dsh-coherence', enabled: true, fiberPhase: 'active' },
    { entryId: 'falcon', moduleName: 'file:///C:/tools/falcon-harness/dsh-plugin/lib/index.js', enabled: true, fiberPhase: 'failed' },
    { entryId: 'coherence-ui', moduleName: 'dsh-client-ui-coherence', enabled: true, fiberPhase: null },
    { entryId: 'coherence-inventory', moduleName: 'dsh-client-ui-coherence-inventory', enabled: true, fiberPhase: 'active' },
    { entryId: 'caret', moduleName: 'dsh-drop-caret', enabled: false, fiberPhase: null },
  ],
} as unknown as Snapshot

describe('PackageGroupsSettingsTab', () => {
  it('renders declared packages in order with member rows and phase labels', async () => {
    const deferred = Promise.withResolvers<Snapshot>()
    const list = vi.fn(() => deferred.promise)
    const view = render(<PackageGroupsSettingsTab {...props(list)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()

    await act(async () => { deferred.resolve(SNAPSHOT) })
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByText(en.hint)).toBeTruthy()

    const sections = view.container.querySelectorAll('[data-package-group]')
    expect([...sections].map(section => section.getAttribute('data-package-group'))).toEqual([
      'coherence',
      'falcon',
      'dsh-native',
      'other',
    ])
    expect(screen.getByRole('heading', { name: 'Coherence' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'FalconHarness' })).toBeTruthy()

    const rows = view.container.querySelectorAll('[data-plugin-entry]')
    expect([...rows].map(row => row.getAttribute('data-plugin-entry'))).toEqual([
      'coherence',
      'coherence-ui',
      'coherence-inventory',
      'falcon',
      'jobs',
      'caret',
    ])
    expect(screen.getAllByRole('img', { name: 'Mounted' })).toHaveLength(3)
    expect(screen.getByRole('img', { name: 'Mount failed' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Not mounted' })).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
  })

  it('hides empty declared groups and shows the empty state for no plugins', async () => {
    const view = render(<PackageGroupsSettingsTab {...props(async () => ({ entries: [] }))} />)
    await screen.findByText(en.empty)
    expect(view.container.querySelector('[data-package-group]')).toBeNull()

    view.unmount()
    render(<PackageGroupsSettingsTab {...props(async () => SNAPSHOT)} />)
    await screen.findByRole('heading', { name: 'Other' })
    expect(screen.queryByRole('heading', { name: 'FalconHarness' })).toBeTruthy()
  })

  it('shows a generic failure and retries', async () => {
    const list = vi.fn<PackageGroupsSettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PackageGroupsSettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    screen.getByRole('button', { name: en.retry }).click()
    await screen.findByText(en.empty)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('toggles a package group over its toggleable members and reloads on success', async () => {
    const setDisabled = vi.fn(async () => ({ results: [] }))
    const reload = vi.fn()
    const view = render(<PackageGroupsSettingsTab {...props(async () => SNAPSHOT, { setDisabled, reload })} />)

    const coherenceToggle = await vi.waitFor(() => {
      const section = view.container.querySelector('[data-package-group="coherence"]')!
      expect(section).toBeTruthy()
      return within(section as HTMLElement).getByRole('button', { name: en.disable })
    })
    fireEvent.click(coherenceToggle)
    await vi.waitFor(() => { expect(setDisabled).toHaveBeenCalledOnce() })
    // The control surface (`ui-coherence-inventory`) is excluded; the toggle
    // covers the host plugin and its browser half only.
    expect(setDisabled).toHaveBeenCalledWith({
      entryIds: ['coherence', 'coherence-ui'],
      disabled: true,
    })
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
  })

  it('keeps the page and surfaces the failure when a member refuses the toggle', async () => {
    const setDisabled = vi.fn(async () => ({
      results: [
        { entryId: 'coherence', applied: true },
        { entryId: 'coherence-ui', applied: false, error: 'entry re-init failed' },
      ],
    }) as unknown as PluginControlSetDisabledResult)
    const reload = vi.fn()
    const view = render(<PackageGroupsSettingsTab {...props(async () => SNAPSHOT, { setDisabled, reload })} />)

    fireEvent.click(await vi.waitFor(() => {
      const section = view.container.querySelector('[data-package-group="coherence"]')!
      return within(section as HTMLElement).getByRole('button', { name: en.disable })
    }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain(en.toggleFailed)
    expect(screen.getByRole('alert').textContent).toContain('entry re-init failed')
    expect(reload).not.toHaveBeenCalled()
  })

  it('offers no toggle on read-only groups', async () => {
    const view = render(<PackageGroupsSettingsTab {...props(async () => SNAPSHOT)} />)
    await vi.waitFor(() => {
      expect(view.container.querySelector('[data-package-group="coherence"] button')).toBeTruthy()
    })
    // Two toggleable groups (coherence, falcon); DSH and other stay read-only.
    expect(view.container.querySelectorAll('.groupToggle, [class*="groupToggle"]')).toHaveLength(2)
    const sections = screen.getAllByRole('heading').map(heading => heading.textContent)
    expect(sections).toContain('DSH')
    expect(sections).toContain('Other')
  })
})
