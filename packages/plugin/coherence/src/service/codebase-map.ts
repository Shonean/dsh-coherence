/**
 * Codebase-map service (`ctx.codebaseMap`): persisted Explore outcomes —
 * folders, files, symbols, and one explore record per capture — so a later
 * session answers structure questions from the map instead of re-exploring.
 *
 * Records are sharded per workspace (see `workspace-shards.ts`): every method
 * takes an optional `workspaceId`; a caller without one reads and writes the
 * legacy shard. When a workspace shard opens for the first time, map nodes
 * whose address lives under the workspace path migrate out of the legacy
 * shard, so pre-isolation backfills become workspace-owned.
 * @module dsh-coherence/src/service/codebase-map
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  codebaseMapDomain,
  type ExploreRecord,
  type FileNode,
  type FolderNode,
  type SymbolNode,
} from '../domain/codebase-map.ts'
import { pathIsWithin, WorkspaceShards, type WorkspaceShard } from '../workspace-shards.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codebaseMap: CodebaseMapService
  }
}

/** One map node kind. */
export type CodebaseMapNodeKind = 'folder' | 'file' | 'symbol'

/** Any stored codebase-map node. */
export type CodebaseMapNode = FolderNode | FileNode | SymbolNode

/** List filter. */
export interface CodebaseMapFilter {
  kind?: CodebaseMapMapKind
}

type CodebaseMapMapKind = 'folders' | 'files' | 'symbols'

/** The per-shard table set. */
export interface CodebaseMapTables {
  folders: KvTable<string, FolderNode>
  files: KvTable<string, FileNode>
  symbols: KvTable<string, SymbolNode>
  explores: KvTable<string, ExploreRecord>
}

function folderKey(relativePath: string): string {
  return `f:${relativePath}`
}

function fileKey(relativePath: string): string {
  return `F:${relativePath}`
}

function symbolKey(qualifiedName: string): string {
  return `s:${qualifiedName}`
}

function exploreKey(exploreId: string): string {
  return `x:${exploreId}`
}

/** Migrate legacy nodes whose address lives under the workspace path into the fresh shard. */
async function migrateIntoWorkspace(shard: WorkspaceShard<CodebaseMapTables>, legacy: CodebaseMapTables | undefined): Promise<void> {
  if (legacy === undefined || shard.path === undefined) return
  for (const [key, node] of legacy.folders.entries()) {
    if (pathIsWithin(node.relativePath, shard.path)) {
      await shard.data.folders.put(key, node)
      await legacy.folders.delete(key)
    }
  }
  for (const [key, node] of legacy.files.entries()) {
    if (pathIsWithin(node.relativePath, shard.path)) {
      await shard.data.files.put(key, node)
      await legacy.files.delete(key)
    }
  }
}

/** The codebase-map service. Owns the codebase_map domain family. */
export class CodebaseMapService extends Service {
  /** The storage domain form must be present before the domain opens. */
  static inject = ['storageDomain']

  private shards!: WorkspaceShards<CodebaseMapTables>

  constructor(ctx: Context) {
    super(ctx, 'codebaseMap')
  }

  /** Open the legacy shard plus every registered workspace's shard. */
  protected async [Service.init](): Promise<void> {
    this.shards = new WorkspaceShards<CodebaseMapTables>(this.ctx, 'codebase_map', {
      spec: domainName => ({ ...codebaseMapDomain, name: domainName }),
      open: (domain: Domain<typeof codebaseMapDomain>): CodebaseMapTables => ({
        folders: domain.table('folders'),
        files: domain.table('files'),
        symbols: domain.table('symbols'),
        explores: domain.table('explores'),
      }),
      bootstrap: migrateIntoWorkspace,
    })
    await this.shards.init()
  }

  /**
   * Re-open shards for workspaces that appeared since the last refresh.
   * @returns the workspaces newly sharded by this call.
   */
  refreshShards(): Promise<WorkspaceShard<CodebaseMapTables>[]> {
    return this.shards.refresh()
  }

  /**
   * Resolve a project directory to a workspace shard id.
   * @param projectDir - the directory to resolve.
   * @returns the workspace id, or `undefined` when unregistered.
   */
  resolveWorkspaceId(projectDir?: string): Promise<string | undefined> {
    return this.shards.resolveId(projectDir)
  }

  /**
   * Store or overwrite one map node, routed to its table by node shape.
   * @param node - a folder, file, or symbol node.
   * @param workspaceId - target shard; omitted writes the legacy shard.
   */
  async upsert(node: CodebaseMapNode, workspaceId?: string): Promise<void> {
    const tables = this.shards.require(workspaceId).data
    if ('qualifiedName' in node) {
      await tables.symbols.put(symbolKey(node.qualifiedName), node)
    } else if ('purpose' in node) {
      await tables.folders.put(folderKey(node.relativePath), node)
    } else {
      await tables.files.put(fileKey(node.relativePath), node)
    }
  }

  /**
   * Fetch one node by its address.
   * @param address - the folder/file relative path or symbol qualified name.
   * @param kind - which table to read.
   * @param workspaceId - target shard; omitted reads the legacy shard.
   * @returns the node, or `undefined` when absent.
   */
  get(address: string, kind: 'folder' | 'file' | 'symbol', workspaceId?: string): CodebaseMapNode | undefined {
    const tables = this.shards.require(workspaceId).data
    switch (kind) {
      case 'folder':
        return tables.folders.get(folderKey(address))
      case 'file':
        return tables.files.get(fileKey(address))
      case 'symbol':
        return tables.symbols.get(symbolKey(address))
    }
  }

  /**
   * List stored nodes in one shard. Reads the legacy shard when no
   * workspace is named — never merges workspaces; use {@link listAll} only
   * for shard-agnostic audits.
   * @param filter - optional table filter.
   * @param workspaceId - target shard; omitted reads the legacy shard.
   * @returns matching nodes.
   */
  list(filter: CodebaseMapFilter = {}, workspaceId?: string): CodebaseMapNode[] {
    const out: CodebaseMapNode[] = []
    const shards = [this.shards.require(workspaceId)]
    for (const shard of shards) {
      if (filter.kind === undefined || filter.kind === 'folders') {
        for (const [, node] of shard.data.folders.entries()) out.push(node)
      }
      if (filter.kind === undefined || filter.kind === 'files') {
        for (const [, node] of shard.data.files.entries()) out.push(node)
      }
      if (filter.kind === undefined || filter.kind === 'symbols') {
        for (const [, node] of shard.data.symbols.entries()) out.push(node)
      }
    }
    return out
  }

  /**
   * List nodes across every open shard (legacy plus each workspace). Audit
   * surfaces only — workspace-scoped callers must use {@link list}.
   * @param filter - optional table filter.
   * @returns matching nodes from every shard.
   */
  listAll(filter: CodebaseMapFilter = {}): CodebaseMapNode[] {
    const out: CodebaseMapNode[] = []
    for (const shard of this.shards.all()) {
      if (filter.kind === undefined || filter.kind === 'folders') {
        for (const [, node] of shard.data.folders.entries()) out.push(node)
      }
      if (filter.kind === undefined || filter.kind === 'files') {
        for (const [, node] of shard.data.files.entries()) out.push(node)
      }
      if (filter.kind === undefined || filter.kind === 'symbols') {
        for (const [, node] of shard.data.symbols.entries()) out.push(node)
      }
    }
    return out
  }

  /**
   * Record one Explore capture so the map's provenance and coverage stay
   * auditable.
   * @param record - the explore record.
   * @param workspaceId - target shard; omitted writes the legacy shard.
   */
  async recordExplore(record: ExploreRecord, workspaceId?: string): Promise<void> {
    await this.shards.require(workspaceId).data.explores.put(exploreKey(record.exploreId), record)
  }

  /**
   * Every stored explore record, newest first (all shards).
   * @returns the explore records in descending capture-time order.
   */
  exploreRecords(): ExploreRecord[] {
    const out: ExploreRecord[] = []
    for (const shard of this.shards.all()) {
      for (const [, record] of shard.data.explores.entries()) out.push(record)
    }
    return out.sort((a, b) => b.at - a.at)
  }
}
