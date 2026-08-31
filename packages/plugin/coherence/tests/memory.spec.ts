// Memory service behavior: three-layer writes, semantic dedup and conflict
// marking, soft-delete exclusion from recall, and list filtering.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryService } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage plus the memory service over a temp JSON root. */
async function setup(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-memory-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, { recallMaxTokens: 1024 })
  return ctx
}

describe('memory service', () => {
  it('writes working memory and recalls it by keyword', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'working', content: 'the project uses pnpm workspaces', importance: 0.8 })
    const hit = ctx.memory.recall({ query: 'pnpm' })
    expect(hit.items.length).toBeGreaterThan(0)
    expect(hit.items[0]?.content).toContain('pnpm')
    expect(hit.items[0]?.layer).toBe('working')
  })

  it('deduplicates semantic claims by subject and claim', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'semantic', subject: 'dsh', content: 'everything is a plugin', importance: 0.7 })
    await ctx.memory.write({ layer: 'semantic', subject: 'dsh', content: 'everything is a plugin', importance: 0.9 })
    expect(ctx.memory.stats().semantic).toBe(1)
    const [claim] = ctx.memory.list({ layer: 'semantic' })
    expect(claim).toBeDefined()
    if (claim === undefined) return
    expect('sourceCount' in claim ? claim.sourceCount : 0).toBe(2)
    expect(claim.state).toBe('active')
  })

  it('marks a conflicting semantic claim contradicted and stores the new claim tentative', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'semantic', subject: 'scale', content: 'bigger is better' })
    await ctx.memory.write({ layer: 'semantic', subject: 'scale', content: 'bigger is not enough' })
    const byState = (state: string) => ctx.memory.list({ layer: 'semantic' }).filter(c => c.state === state)
    expect(byState('contradicted').length).toBe(1)
    expect(byState('tentative').length).toBe(1)
    // Recall excludes the contradicted entry.
    expect(ctx.memory.recall({ query: 'bigger' }).items.some(i => i.content.includes('better'))).toBe(false)
  })

  it('forget excludes an entry from recall but keeps it in storage', async () => {
    const ctx = await setup()
    const ref = await ctx.memory.write({ layer: 'working', content: 'stale fact' })
    expect(ctx.memory.recall({ query: 'stale' }).items.length).toBe(1)
    await ctx.memory.forget(ref)
    expect(ctx.memory.recall({ query: 'stale' }).items.length).toBe(0)
    expect(ctx.memory.list({ layer: 'working', state: 'outdated' }).length).toBe(1)
  })

  it('lists and filters entries by layer and agent', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'working', content: 'main-agent fact' })
    await ctx.memory.write({ layer: 'episodic', content: 'opencode did a thing', agentType: 'opencode', sessionId: 's9' })
    expect(ctx.memory.list({ layer: 'working' }).length).toBe(1)
    expect(ctx.memory.list({ agentType: 'opencode' }).length).toBe(1)
    expect(ctx.memory.list({ sessionId: 's9' }).length).toBe(1)
  })

  it('recall budgets tokens across layers', async () => {
    const ctx = await setup()
    for (let index = 0; index < 20; index++) {
      await ctx.memory.write({ layer: 'working', content: `working fact number ${index} is fairly long`, importance: 0.5 })
    }
    const result = ctx.memory.recall({ maxTokens: 100 })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.length).toBeLessThan(20)
    expect(result.budgetUsed.working).toBeGreaterThan(0)
  })
})
