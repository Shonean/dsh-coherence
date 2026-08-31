/**
 * Per-workspace storage shards. dsh's `workspaceRegistry` owns durable
 * workspace records (one canonical path, one uuid each). Coherence keeps its
 * four domains physically separated per workspace: the legacy, unattributed
 * shard keeps the bare domain name (`transcript`, `memory`, …) while each
 * registered workspace gets its own backend unit named `<base>_<hex32>`
 * (the workspace uuid with hyphens stripped — filename-safe under
 * UNIT_NAME_RE). Two workspaces can therefore never mix records, even if a
 * read-side filter regresses.
 *
 * A service owns one {@link WorkspaceShards} over its table-set type `T`:
 * shards open eagerly for every registered workspace at startup and refresh
 * on every ingest poll (so a workspace created after startup lands within a
 * poll cycle), with the legacy shard always present for callers without a
 * workspace and for records that pre-date isolation.
 * @module dsh-coherence/src/workspace-shards
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'

/** Shard key for records not attributable to a registered workspace. */
export const LEGACY_SHARD = '__legacy__'

/** Minimal workspace shape this manager needs (structurally satisfied by dsh-workspace's entity). */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
}

/** One open shard: the routing key, the workspace path (legacy: none), and the per-domain table set. */
export interface WorkspaceShard<T> {
  readonly workspaceId: string
  readonly path: string | undefined
  readonly data: T
}

/** Hooks the owning service supplies for one domain family. */
export interface ShardLifecycle<T> {
  /** Build the per-shard spec from the computed shard domain name. */
  spec(domainName: string): DomainSpec
  /** Project the opened domain into the table-set the service uses. The
   * erased `DomainSpec` view keeps the hook spec-agnostic; implementations
   * narrow to their own domain's spec for typed `table` access. */
  open(domain: Domain<DomainSpec>): T | Promise<T>
  /**
   * First-time hook for a workspace shard: migrate attributable records out
   * of the legacy shard (best effort, path-based). Runs once, right after the
   * shard opens and before it is published to callers.
   */
  bootstrap?(shard: WorkspaceShard<T>, legacy: T | undefined): void | Promise<void>
}

/**
 * Domain name of one shard: bare base for legacy, `base_<hex32>` for a workspace.
 * @param base - the domain's base name.
 * @param workspaceId - the workspace id; `undefined` names the legacy shard.
 * @returns the storage unit name backing that shard.
 */
export function shardDomainName(base: string, workspaceId: string | undefined): string {
  if (workspaceId === undefined) return base
  const hex = workspaceId.replace(/-/g, '')
  // Only a 32-char hex workspace id gets its own shard; anything else falls
  // back to the legacy name so a malformed id can't mint an arbitrary unit.
  return /^[0-9a-f]{32}$/.test(hex) ? `${base}_${hex}` : base
}

/**
 * Whether a stored path belongs to a workspace root (prefix-safe on both separators).
 * @param path - the stored path to test.
 * @param workspacePath - the workspace root it must fall within.
 * @returns whether the path is the root itself or lies under it.
 */
export function pathIsWithin(path: string | undefined, workspacePath: string | undefined): boolean {
  if (path === undefined || workspacePath === undefined || path === '') return false
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = norm(path)
  const root = norm(workspacePath)
  return target === root || target.startsWith(`${root}/`)
}

/**
 * Per-workspace shard manager for one domain family.
 */
export class WorkspaceShards<T> {
  private readonly shards = new Map<string, WorkspaceShard<T>>()
  private readonly bootstrapped = new Set<string>()
  private readonly pathIndex = new Map<string, string>()

  /**
   * @param ctx - plugin context (storageDomain required; workspaceRegistry optional).
   * @param baseName - the domain's base name (`transcript`, `memory`, …).
   * @param lifecycle - per-shard spec/open/bootstrap hooks.
   */
  constructor(
    private readonly ctx: Context,
    private readonly baseName: string,
    private readonly lifecycle: ShardLifecycle<T>,
  ) {}

  /** Open the legacy shard plus one shard per registered workspace. */
  async init(): Promise<void> {
    await this.openLegacy()
    await this.refresh()
  }

  /**
   * Open shards for workspaces that appeared since the last refresh, and
   * re-index workspace paths. Workspaces removed from the registry keep
   * their shard open for the process lifetime (their durable unit stays on
   * disk either way).
   * @returns the workspaces newly sharded in this call (their bootstrap ran).
   */
  async refresh(): Promise<WorkspaceShard<T>[]> {
    const workspaces = this.listWorkspaces()
    const fresh: WorkspaceShard<T>[] = []
    for (const ws of workspaces) {
      this.pathIndex.set(this.norm(ws.path), ws.id)
      if (!this.shards.has(ws.id)) {
        const shard = await this.openWorkspace(ws.id, ws.path)
        fresh.push(shard)
      }
    }
    return fresh
  }

  /**
   * Resolve a project directory to a registered workspace id.
   * @param projectDir - any spelling of a workspace path (realpath applied by the registry).
   * @returns the workspace id, or `undefined` when unregistered.
   */
  async resolveId(projectDir: string | undefined): Promise<string | undefined> {
    if (projectDir === undefined || projectDir === '') return undefined
    const registry = this.ctx.get('workspaceRegistry') as
      | { resolveByPath?: (path: string) => Promise<WorkspaceLike | undefined> }
      | undefined
    if (registry?.resolveByPath === undefined) return undefined
    try {
      const ws = await registry.resolveByPath(projectDir)
      return ws?.id
    } catch {
      return undefined
    }
  }

  /**
   * Synchronous best-effort resolution: match a path against the indexed
   * workspace roots (longest prefix, case-insensitive, separator-tolerant).
   * For synchronous callers (prompt sections); async callers should use
   * {@link resolveId}, which realpaths through the registry.
   * @param projectDir - any spelling of a path inside a workspace.
   * @returns the workspace id, or `undefined` when no registered root matches.
   */
  resolveIdSync(projectDir: string | undefined): string | undefined {
    if (projectDir === undefined || projectDir === '') return undefined
    const norm = this.norm(projectDir)
    let bestId: string | undefined
    let bestLen = -1
    for (const [root, id] of this.pathIndex) {
      if (norm === root || norm.startsWith(`${root}/`)) {
        if (root.length > bestLen) {
          bestId = id
          bestLen = root.length
        }
      }
    }
    return bestId
  }

  /**
   * The shard for a workspace id, falling back to legacy for `undefined` or
   * an id whose shard has not opened (e.g. created after the last refresh).
   * @param workspaceId - the workspace id to route by; `undefined` is legacy.
   * @returns the open shard backing that id.
   */
  require(workspaceId: string | undefined): WorkspaceShard<T> {
    const shard = (workspaceId !== undefined ? this.shards.get(workspaceId) : undefined) ?? this.shards.get(LEGACY_SHARD)
    if (shard === undefined) throw new Error(`dsh-coherence: ${this.baseName} shards are not initialized`)
    return shard
  }

  /**
   * Every open shard, legacy first.
   * @returns the open shards in legacy-first iteration order.
   */
  all(): WorkspaceShard<T>[] {
    const legacy = this.shards.get(LEGACY_SHARD)
    const rest = [...this.shards.values()].filter(shard => shard.workspaceId !== LEGACY_SHARD)
    return legacy === undefined ? rest : [legacy, ...rest]
  }

  /**
   * The legacy (unattributed) table set.
   * @returns the table set of the legacy shard.
   */
  legacy(): T {
    return this.require(undefined).data
  }

  private listWorkspaces(): WorkspaceLike[] {
    const registry = this.ctx.get('workspaceRegistry') as { list?: () => WorkspaceLike[] } | undefined
    if (registry?.list === undefined) return []
    try {
      return registry.list()
    } catch {
      return []
    }
  }

  private norm(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  private async openLegacy(): Promise<WorkspaceShard<T>> {
    const existing = this.shards.get(LEGACY_SHARD)
    if (existing !== undefined) return existing
    const spec = this.lifecycle.spec(this.baseName)
    const domain = await this.ctx.storageDomain.open(spec)
    this.ctx.effect(() => () => domain.close(), `dsh-coherence.${this.baseName}.legacy`)
    const data = await this.lifecycle.open(domain)
    const shard: WorkspaceShard<T> = { workspaceId: LEGACY_SHARD, path: undefined, data }
    this.shards.set(LEGACY_SHARD, shard)
    this.bootstrapped.add(LEGACY_SHARD)
    return shard
  }

  private async openWorkspace(id: string, path: string): Promise<WorkspaceShard<T>> {
    const domainName = shardDomainName(this.baseName, id)
    const spec = this.lifecycle.spec(domainName)
    const domain = await this.ctx.storageDomain.open(spec)
    this.ctx.effect(() => () => domain.close(), `dsh-coherence.${this.baseName}.${id}`)
    const data = await this.lifecycle.open(domain)
    const shard: WorkspaceShard<T> = { workspaceId: id, path, data }
    this.shards.set(id, shard)
    if (!this.bootstrapped.has(id)) {
      this.bootstrapped.add(id)
      await this.lifecycle.bootstrap?.(shard, this.shards.get(LEGACY_SHARD)?.data)
    }
    return shard
  }
}
