// Codebase-map service behavior: node upsert/get/list and explore records.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CodebaseMapService } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage plus the codebase-map service over a temp JSON root. */
async function setup(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-map-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(CodebaseMapService)
  return ctx
}

describe('codebase map service', () => {
  it('upserts and fetches folder, file, and symbol nodes', async () => {
    const ctx = await setup()
    await ctx.codebaseMap.upsert({
      relativePath: 'src',
      name: 'src',
      purpose: 'product source',
      keyFiles: ['src/index.ts'],
      summary: 'all source code',
      exploredAt: 1000,
    })
    await ctx.codebaseMap.upsert({
      relativePath: 'src/index.ts',
      kind: 'source',
      summary: 'package entry',
      keySymbols: [],
      responsibilities: ['exports the plugin'],
      exploredAt: 1000,
    })
    await ctx.codebaseMap.upsert({
      qualifiedName: 'index.ts#apply',
      kind: 'function',
      file: 'src/index.ts',
      docSummary: 'mounts the suite',
    })
    expect(ctx.codebaseMap.get('src', 'folder')).toBeDefined()
    expect(ctx.codebaseMap.get('src/index.ts', 'file')).toBeDefined()
    expect(ctx.codebaseMap.get('index.ts#apply', 'symbol')).toBeDefined()
    expect(ctx.codebaseMap.get('missing', 'folder')).toBeUndefined()
  })

  it('lists nodes by table', async () => {
    const ctx = await setup()
    await ctx.codebaseMap.upsert({
      relativePath: 'a',
      name: 'a',
      purpose: 'p',
      keyFiles: [],
      summary: 's',
      exploredAt: 1,
    })
    await ctx.codebaseMap.upsert({
      qualifiedName: 'x#y',
      kind: 'function',
      file: 'a',
      docSummary: 'd',
    })
    expect(ctx.codebaseMap.list({ kind: 'folders' }).length).toBe(1)
    expect(ctx.codebaseMap.list({ kind: 'symbols' }).length).toBe(1)
    expect(ctx.codebaseMap.list().length).toBe(2)
  })

  it('records and lists explore captures', async () => {
    const ctx = await setup()
    await ctx.codebaseMap.recordExplore({
      exploreId: 'x1',
      at: 2000,
      rootPath: '/repo',
      strategy: 'agent-explore',
      discovered: { folderCount: 3, fileCount: 10, symbolCount: 4 },
      summary: 'scanned src',
    })
    const records = ctx.codebaseMap.exploreRecords()
    expect(records.length).toBe(1)
    expect(records[0]?.exploreId).toBe('x1')
  })
})
