/**
 * Declarative plugin-package grouping for the Plugins settings' grouped view.
 * The Loader snapshot carries no bundle-origin metadata, so package membership
 * is declared here as ordered match rules over each entry's module name:
 * first matching rule wins, unmatched entries fall into a trailing "other"
 * group. Adding a package is editing {@link DEFAULT_GROUPS} — no protocol or
 * Host change. @module
 */

/** Minimal entry shape the grouping consumes (the pluginInventory snapshot row). */
export interface GroupableEntry {
  /** Loader entry id. */
  entryId: string
  /** Module specifier the Loader resolved for the entry (package name or file URL). */
  moduleName: string
}

/** One declared plugin package: its display label plus ordered match patterns. */
export interface PackageGroupRule {
  /** Stable group id (test/anchor target). */
  id: string
  /** Localized-independent display label of the package. */
  label: string
  /**
   * Ordered patterns over the module name: an exact name, a `prefix*`
   * wildcard, or a `*substr*` wildcard. First matching pattern claims the
   * entry; groups are tried in declaration order.
   */
  match: readonly string[]
}

/** One resolved plugin package with the entries it claimed, in snapshot order. */
export interface PackageGroup<T extends GroupableEntry = GroupableEntry> extends PackageGroupRule {
  /** Entries claimed by this group, in snapshot order. */
  entries: T[]
}

/**
 * Whether one module name satisfies one match pattern.
 * @param moduleName - the entry's module specifier.
 * @param pattern - exact name, `prefix*`, or `*substr*`.
 */
function matchesPattern(moduleName: string, pattern: string): boolean {
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length >= 2) {
    return moduleName.includes(pattern.slice(1, -1))
  }
  if (pattern.endsWith('*')) {
    return moduleName.startsWith(pattern.slice(0, -1))
  }
  return moduleName === pattern
}

/**
 * Partition snapshot entries into the declared packages, in declaration
 * order, with unmatched entries appended as the trailing fallback group.
 * Pure; group relative order and member order are both stable.
 * @param entries - snapshot rows in snapshot order.
 * @param groups - declared packages in display order.
 * @param fallback - label for the group holding unmatched entries.
 * @returns one resolved group per declaration plus the fallback group (only when non-empty).
 */
export function groupEntries<T extends GroupableEntry>(
  entries: readonly T[],
  groups: readonly PackageGroupRule[],
  fallback: string,
): Array<PackageGroup<T>> {
  const resolved: Array<PackageGroup<T>> = groups.map(rule => ({ ...rule, entries: [] }))
  const other: PackageGroup<T> = { id: 'other', label: fallback, match: [], entries: [] }
  for (const entry of entries) {
    const group = resolved.find(rule =>
      rule.match.some(pattern => matchesPattern(entry.moduleName, pattern)),
    )
    ;(group ?? other).entries.push(entry)
  }
  return other.entries.length > 0 ? [...resolved, other] : resolved
}

/** The coherence family's exact module names (host plugin + browser halves). */
const COHERENCE_MODULES = [
  'dsh-coherence',
  'dsh-client-ui-coherence',
  'dsh-client-ui-coherence-hub',
  'dsh-client-ui-coherence-inventory',
] as const

/**
 * Group ids whose members the package view may enable/disable. The native and
 * fallback groups stay read-only: they hold the webserver, settings, and the
 * rest of the deployment's own scaffolding, which must not be disposable from
 * the web UI.
 */
export const TOGGLEABLE_GROUP_IDS: readonly string[] = ['coherence', 'falcon']

/**
 * Module names the toggle must never send to the gateway even when they sit
 * inside a toggleable group: `ui-coherence-inventory` is this control surface
 * itself — disabling it would take away the switch needed to re-enable.
 */
export const UNTOGGLEABLE_MODULE_NAMES: readonly string[] = [
  'dsh-client-ui-coherence-inventory',
]

/**
 * Whether one group's members may be toggled from the package view.
 * @param groupId - the resolved group id.
 * @returns whether the group as a whole is toggleable.
 */
export function isToggleableGroup(groupId: string): boolean {
  return TOGGLEABLE_GROUP_IDS.includes(groupId)
}

/**
 * Whether one entry participates in group toggles (control-plane entries do
 * not).
 * @param moduleName - the entry's module specifier.
 * @returns whether the entry toggles with its group.
 */
export function isToggleableEntry(moduleName: string): boolean {
  return !UNTOGGLEABLE_MODULE_NAMES.includes(moduleName)
}

/**
 * Default package declarations: coherence first, then falcon (loaded from a
 * local file:// URL, matched by substring), then every remaining DSH-scoped
 * package as the native group.
 */
export const DEFAULT_GROUPS: readonly PackageGroupRule[] = [
  { id: 'coherence', label: 'Coherence', match: [...COHERENCE_MODULES] },
  { id: 'falcon', label: 'FalconHarness', match: ['*falcon*'] },
  { id: 'dsh-native', label: 'DSH', match: ['@deepseek-ai/*'] },
]
