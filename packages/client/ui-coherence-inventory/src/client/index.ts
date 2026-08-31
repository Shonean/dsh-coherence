/** Read-only package-grouped Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the rc.2 pluginInventory Remote namespace merge so
// ctx.remote.pluginInventory types against its host owner. The post-rc.2
// pluginControl toggle face has no published merge yet; it is typed locally
// below (see the slice cast in apply).
import type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import {
  PackageGroupsSettingsTab,
  type PackageGroupsSettingsTabInjected,
  type PluginControlSetDisabledResult,
} from './PackageGroupsSettingsTab.tsx'
import { en, zh, type PackageGroupsLocaleKey } from './locales.ts'

export type { PackageGroupsSettingsTabInjected, PackageGroupsSettingsTabProps } from './PackageGroupsSettingsTab.tsx'
export type { PackageGroupsLocaleKey } from './locales.ts'
export { DEFAULT_GROUPS, groupEntries, isToggleableEntry, isToggleableGroup, TOGGLEABLE_GROUP_IDS, UNTOGGLEABLE_MODULE_NAMES } from './groups.ts'
export type { PackageGroup, PackageGroupRule } from './groups.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Package-grouped plugin inventory copy. */
    'settings.packageGroups': PackageGroupsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.packageGroups'

/** Services required by the Settings registration and generated Remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginControl']

/** Contribute the lazy package-groups tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coherence-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PackageGroupsSettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  // The pluginControl toggle gateway ships in the host after rc.2; read it
  // through a locally-declared slice of ctx.remote (the rc.2 Remote aggregate
  // publishes only pluginInventory). At runtime the post-rc.2 host serves it.
  const pluginControl = (ctx.remote as unknown as {
    pluginControl: {
      setDisabled: (args: { entryIds: string[]; disabled: boolean }) => Promise<
        | { ok: true; value: PluginControlSetDisabledResult }
        | { ok: false; error: { code: string; message: string } }
      >
    }
  }).pluginControl
  const setDisabled: PackageGroupsSettingsTabInjected['setDisabled'] = async (args) => {
    const result = await pluginControl.setDisabled(args)
    if (!result.ok) {
      throw new Error(`pluginControl.setDisabled failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const injected = (): PackageGroupsSettingsTabInjected => ({ list, setDisabled, reload: () => { window.location.reload() } })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'packages',
    order: 11,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PackageGroupsSettingsTab))
}
