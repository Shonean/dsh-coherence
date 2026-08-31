import { useEffect, useMemo, useState, type ReactNode } from 'react'
// The inventory snapshot is owned by the host plugin-inventory package (its
// read-only Remote face ships in rc.2). The control gateway that toggles
// entries ships in the host after rc.2, so its result row is declared locally.
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/** Per-entry outcome of one package-toggle call (post-rc.2 plugin-control gateway). */
export interface PluginControlEntryResult {
  /** The entry id as requested. */
  entryId: string
  /** Whether the live Loader update succeeded. */
  applied: boolean
  /** Failure detail when `applied` is false. */
  error?: string
}

/** Result of one package-toggle call (post-rc.2 plugin-control gateway). */
export interface PluginControlSetDisabledResult {
  /** Per-entry application outcome. */
  results: ReadonlyArray<PluginControlEntryResult>
}
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_GROUPS, groupEntries, isToggleableEntry, isToggleableGroup } from './groups.ts'
import type { PackageGroupsLocaleKey } from './locales.ts'
import css from './PackageGroupsSettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface PackageGroupsSettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /** Toggle Loader entries and persist the state across restarts. */
  setDisabled: (args: {
    entryIds: string[]
    disabled: boolean
  }) => Promise<PluginControlSetDisabledResult>
  /** Apply the recomposed frontend: a full SPA reload. Injectable for tests. */
  reload: () => void
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Full component props assembled by the Settings slot renderer. */
export type PackageGroupsSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.packageGroups'>
  & InjectFace<PackageGroupsSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PackageGroupsLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PackageGroupsSettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Render the current Loader inventory grouped by declared plugin package. */
export function PackageGroupsSettingsTab({ list, setDisabled, reload, t }: PackageGroupsSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<{ groupId: string; message: string } | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const groups = useMemo(
    () => state.status === 'ready'
      ? groupEntries(state.snapshot.entries, DEFAULT_GROUPS, t('other'))
      : [],
    [state, t],
  )

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  /**
   * Toggle one package group: send its toggleable member entries to the Host
   * gateway, then reload the whole SPA so the boot manifest recomposes and the
   * frontend actually switches. A failed call surfaces the error inline and
   * leaves the page untouched.
   * @param groupId - the group being toggled.
   * @param memberEntryIds - the group's toggleable member entry ids.
   * @param disabled - the target state.
   */
  const toggleGroup = (groupId: string, memberEntryIds: string[], disabled: boolean): void => {
    setToggling(groupId)
    setToggleError(null)
    void Promise.resolve()
      .then(() => setDisabled({ entryIds: memberEntryIds, disabled }))
      .then((result) => {
        const failure = result.results.find(item => !item.applied)
        if (failure !== undefined) {
          setToggling(null)
          setToggleError({ groupId, message: failure.error ?? failure.entryId })
          return
        }
        // The boot manifest is composed server-side; only a full reload picks
        // up the recomposed client graph.
        reload()
      })
      .catch((error: unknown) => {
        setToggling(null)
        setToggleError({ groupId, message: String(error) })
      })
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <p className={css.hint}>{t('hint')}</p>
          {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          <div className={css.groups}>
            {groups.map(group => group.entries.length > 0 ? (
              <section className={css.group} key={group.id} data-package-group={group.id}>
                <div className={css.groupHeading}>
                  <h3>{group.label}</h3>
                  <span>{group.entries.length}</span>
                  {isToggleableGroup(group.id) ? (() => {
                    const toggleable = group.entries.filter(entry => isToggleableEntry(entry.moduleName))
                    const groupDisabled = toggleable.some(entry => !entry.enabled)
                    return (
                      <button
                        type="button"
                        className={css.groupToggle}
                        data-disabled={groupDisabled ? 'true' : 'false'}
                        disabled={toggling !== null}
                        onClick={() => { toggleGroup(group.id, toggleable.map(entry => entry.entryId), !groupDisabled) }}
                      >
                        {toggling === group.id ? t('toggling') : groupDisabled ? t('enable') : t('disable')}
                      </button>
                    )
                  })() : null}
                </div>
                {toggleError?.groupId === group.id && toggling === null ? (
                  <p className={css.failure} role="alert">{t('toggleFailed')}<code>{toggleError.message}</code></p>
                ) : null}
                <ul className={css.rows}>
                  {group.entries.map((entry) => {
                    const status = phaseLabel(entry.fiberPhase, t)
                    return (
                      <li className={css.row} key={entry.entryId} data-plugin-entry={entry.entryId}>
                        <span className={css.rowTitle} title={entry.moduleName}>
                          {moduleShortName(entry.moduleName)}
                        </span>
                        <span className={css.rowTrailing}>
                          {entry.enabled ? (
                            <span
                              className={css.statusDot}
                              data-phase={entry.fiberPhase ?? 'unobserved'}
                              role="img"
                              aria-label={status}
                              title={status}
                            />
                          ) : null}
                          <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                            {t(entry.enabled ? 'enabledTag' : 'disabledTag')}
                          </span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null)}
          </div>
        </>
      ) : null}
    </div>
  )
}
