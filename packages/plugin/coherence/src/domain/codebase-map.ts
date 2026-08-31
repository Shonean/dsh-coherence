/**
 * Codebase-map domain: the persisted outcome of Explore work — folder and file
 * structure, key symbols, and one explore record per capture — so a later
 * session can answer structure questions from the map instead of re-exploring.
 * @module dsh-coherence/src/domain/codebase-map
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ExploreKey, FileKey, FolderKey, SymbolKey } from '../types.ts'

/** One folder node: purpose, key files, and a one-line summary. */
export const folderNodeSchema = z.object({
  relativePath: z.string(),
  name: z.string(),
  purpose: z.string(),
  keyFiles: z.array(z.string()),
  summary: z.string(),
  exploredAt: z.number().int().nonnegative(),
  exploreRef: z.string().optional(),
})

/** One file node: kind, responsibilities, and its key symbols. */
export const fileNodeSchema = z.object({
  relativePath: z.string(),
  kind: z.enum(['source', 'test', 'config', 'docs', 'generated']),
  summary: z.string(),
  keySymbols: z.array(z.object({
    qualifiedName: z.string(),
    kind: z.enum(['class', 'function', 'interface', 'type', 'const', 'enum']),
  })),
  responsibilities: z.array(z.string()),
  exploredAt: z.number().int().nonnegative(),
  exploreRef: z.string().optional(),
})

/** One symbol node with its owning file and doc summary. */
export const symbolNodeSchema = z.object({
  qualifiedName: z.string(),
  kind: z.enum(['class', 'function', 'interface', 'type', 'const', 'enum']),
  file: z.string(),
  docSummary: z.string(),
  exports: z.boolean().optional(),
})

/** One Explore capture: who/where/when and what it discovered. */
export const exploreRecordSchema = z.object({
  exploreId: z.string().min(1),
  at: z.number().int().nonnegative(),
  rootPath: z.string(),
  strategy: z.enum(['agent-explore', 'tool', 'ingest']),
  discovered: z.object({
    folderCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    symbolCount: z.number().int().nonnegative(),
  }),
  summary: z.string(),
})

/** The codebase-map domain declaration. */
export const codebaseMapDomain = defineDomain({
  name: 'codebase_map',
  version: 1,
  tables: {
    folders: domainTable<FolderKey, z.infer<typeof folderNodeSchema>>(folderNodeSchema),
    files: domainTable<FileKey, z.infer<typeof fileNodeSchema>>(fileNodeSchema),
    symbols: domainTable<SymbolKey, z.infer<typeof symbolNodeSchema>>(symbolNodeSchema),
    explores: domainTable<ExploreKey, z.infer<typeof exploreRecordSchema>>(exploreRecordSchema),
  },
})

/** One folder node: purpose, key files, and a one-line summary. */
export type FolderNode = z.infer<typeof folderNodeSchema>
/** One file node: kind, responsibilities, and its key symbols. */
export type FileNode = z.infer<typeof fileNodeSchema>
/** One symbol node with its owning file and doc summary. */
export type SymbolNode = z.infer<typeof symbolNodeSchema>
/** One Explore capture: who/where/when and what it discovered. */
export type ExploreRecord = z.infer<typeof exploreRecordSchema>
