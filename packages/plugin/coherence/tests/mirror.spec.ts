// Mirror rendering: the suite's domains project into human-readable markdown.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CodebaseMapService, MemoryService, WorklogService, renderMirrorFiles } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount the memory, worklog, and codebase-map services. */
async function setup(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-mirror-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService)
  await ctx.plugin(WorklogService)
  await ctx.plugin(CodebaseMapService)
  return ctx
}

describe('mirror rendering', () => {
  it('renders direction, memory, and codebase-map files from the domains', async () => {
    const ctx = await setup()
    const mirrorRoot = join(root!, 'mirror')
    await ctx.worklog.updateDirection({ title: 'Ship the plugin', objective: 'Finish the suite' })
    await ctx.memory.write({ layer: 'semantic', subject: 'dsh', content: 'everything is a plugin', importance: 0.8 })
    await ctx.codebaseMap.upsert({
      relativePath: 'src',
      name: 'src',
      purpose: 'source',
      keyFiles: [],
      summary: 'all source',
      exploredAt: 1000,
    })

    const files = new Map(renderMirrorFiles(ctx, mirrorRoot))
    expect(files.has(join(mirrorRoot, 'DIRECTION.md'))).toBe(true)
    expect(files.has(join(mirrorRoot, 'memory-semantic.md'))).toBe(true)
    expect(files.has(join(mirrorRoot, 'memory-episodic.md'))).toBe(true)
    expect(files.has(join(mirrorRoot, 'codebase-map.md'))).toBe(true)
    expect(files.get(join(mirrorRoot, 'DIRECTION.md'))).toContain('Finish the suite')
    expect(files.get(join(mirrorRoot, 'memory-semantic.md'))).toContain('everything is a plugin')
    expect(files.get(join(mirrorRoot, 'codebase-map.md'))).toContain('src')
  })

  it('renders empty placeholders when a domain has no data', async () => {
    const ctx = await setup()
    const mirrorRoot = join(root!, 'mirror')
    const files = new Map(renderMirrorFiles(ctx, mirrorRoot))
    expect(files.get(join(mirrorRoot, 'DIRECTION.md'))).toContain('No active direction')
    expect(files.get(join(mirrorRoot, 'memory-semantic.md'))).toContain('_(empty)_')
  })
})
