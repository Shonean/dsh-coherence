// Offline consolidation: active episodes replay into semantic claims, the
// replayed episodes become outdated, and the state row records the run.
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
import { runConsolidation } from '../src/service/consolidation.ts'

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
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-consolidate-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService)
  return ctx
}

describe('memory consolidation', () => {
  it('replays episodes into semantic claims and marks them outdated', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'episodic', content: 'claude fixed the ingest bug', agentType: 'claude-code', importance: 0.7 })
    await ctx.memory.write({ layer: 'episodic', content: 'opencode resolved the db path', agentType: 'opencode', importance: 0.6 })
    expect(ctx.memory.stats().episodic).toBe(2)
    expect(ctx.memory.stats().semantic).toBe(0)

    const report = await ctx.memory.consolidate()
    expect(report.episodesConsolidated).toBe(2)
    expect(report.claimsAdded).toBe(2)
    expect(ctx.memory.stats().semantic).toBe(2)
    // Episodes are now outdated; the consolidated semantic claim ranks first
    // for the keyword.
    expect(ctx.memory.list({ layer: 'episodic', state: 'outdated' }).length).toBe(2)
    expect(ctx.memory.recall({ query: 'ingest' }).items[0]?.content).toContain('ingest')
  })

  it('merges episodes with an identical summary into one claim', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'episodic', content: 'the same outcome' })
    await ctx.memory.write({ layer: 'episodic', content: 'the same outcome' })
    const report = await ctx.memory.consolidate()
    expect(report.episodesConsolidated).toBe(2)
    expect(report.claimsAdded).toBe(1)
    expect(report.claimsMerged).toBe(1)
    expect(ctx.memory.stats().semantic).toBe(1)
  })

  it('falls back to a direct consolidation when the composed registry rejects the job start', async () => {
    const ctx = await setup()
    await ctx.memory.write({ layer: 'episodic', content: 'claude fixed the ingest bug', agentType: 'claude-code', importance: 0.7 })
    // A composed-but-unserved registry: the desktop root agent carries the
    // jobs service without a job controller in its own composition.
    const rejectingRegistry = {
      start: () => { throw new Error('background jobs unavailable: no job controller serves this agent') },
    }
    const ctxWithJobs = { get: (key: string) => (key === 'jobs' ? rejectingRegistry : undefined) } as unknown as Context
    await runConsolidation(ctxWithJobs, ctx.memory)
    expect(ctx.memory.stats().semantic).toBe(1)
  })
})
