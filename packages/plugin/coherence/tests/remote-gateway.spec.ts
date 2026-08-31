// Remote gateway: stats/list/recall projections over the memory and transcript
// services, and the per-source ingest status across shards.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryService, TranscriptService, CoherenceRemoteGateway } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage + memory + transcript + the gateway and return the gateway. */
async function gateway(): Promise<CoherenceRemoteGateway> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-remote-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TranscriptService)
  await ctx.plugin(MemoryService)
  await ctx.plugin(CoherenceRemoteGateway)
  return ctx.get('coherence') as CoherenceRemoteGateway
}

describe('coherence remote gateway', () => {
  it('stats counts memory layers and one ingest row per managed agent', async () => {
    const g = await gateway()
    const memory = context!.get('memory') as MemoryService
    await memory.write({ layer: 'working', content: 'gateway fact', importance: 0.5 })
    await memory.write({ layer: 'episodic', content: 'gateway episode', importance: 0.6 })
    const stats = g.stats({})
    expect(stats.memory).toEqual({ working: 1, episodic: 1, semantic: 0 })
    expect(stats.ingest.map(row => row.agentType)).toEqual(['main', 'claude-code', 'opencode', 'codex'])
    expect(stats.ingest.every(row => row.messages === 0 && row.lastActivityAt === 0)).toBe(true)
  })

  it('lists entries as normalized wire rows and honors filters', async () => {
    const g = await gateway()
    const memory = context!.get('memory') as MemoryService
    await memory.write({ layer: 'working', content: 'first fact', importance: 0.4 })
    await memory.write({ layer: 'working', content: 'second fact', importance: 0.9 })
    const { entries } = g.listMemory({})
    expect(entries.map(entry => entry.text).sort()).toEqual(['first fact', 'second fact'])
    expect(entries[0]!.state).toBe('active')
    expect(entries[0]!.layer).toBe('working')

    const filtered = g.listMemory({ agentType: 'codex' })
    expect(filtered.entries).toHaveLength(0)
    const limited = g.listMemory({ limit: 1 })
    expect(limited.entries).toHaveLength(1)
  })

  it('recalls ranked hits with the budget envelope', async () => {
    const g = await gateway()
    const memory = context!.get('memory') as MemoryService
    await memory.write({ layer: 'working', content: 'the gateway projects coherence data' })
    const result = g.recallMemory({ query: 'coherence' })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0]!.text).toContain('coherence')
    expect(result.budgetUsed).toHaveProperty('working')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports per-source transcript activity across shards', async () => {
    const g = await gateway()
    const transcript = context!.get('transcript') as TranscriptService
    await transcript.ingest({
      agentType: 'claude-code',
      sessionId: 's1',
      messages: [{
        agentType: 'claude-code', sessionId: 's1', messageId: 'm1', role: 'user',
        timestamp: 1_788_175_266_000, parts: [{ kind: 'text', text: 'hello' }],
      }],
    })
    const status = g.stats({}).ingest
    const claude = status.find(row => row.agentType === 'claude-code')
    expect(claude).toMatchObject({ messages: 1, lastActivityAt: 1_788_175_266_000 })
  })

  it('filters memory reads by workspace shard and lists workspaces', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coherence-remote-'))
    const ctx = new Context()
    context = ctx
    const workspaceId = 'a'.repeat(32)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: workspaceId, path: '/repo/app' }],
      resolveByPath: async (path: string) =>
        path.startsWith('/repo/app') ? { id: workspaceId, path: '/repo/app' } : undefined,
    } as never)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(TranscriptService)
    await ctx.plugin(MemoryService)
    await ctx.plugin(CoherenceRemoteGateway)
    const g = ctx.get('coherence') as CoherenceRemoteGateway
    const memory = ctx.get('memory') as MemoryService

    // One entry per shard, same key space otherwise.
    await memory.write({ layer: 'working', content: 'legacy note' })
    await memory.write({ layer: 'working', content: 'workspace note' }, workspaceId)

    expect(g.stats({}).memory).toEqual({ working: 1, episodic: 0, semantic: 0 })
    expect(g.stats({ workspaceId }).memory).toEqual({ working: 1, episodic: 0, semantic: 0 })
    expect(g.listMemory({}).entries.map(row => row.text)).toEqual(['legacy note'])
    expect(g.listMemory({ workspaceId }).entries.map(row => row.text)).toEqual(['workspace note'])
    const recalled = g.recallMemory({ query: 'note', workspaceId })
    expect(recalled.items.map(item => item.text)).toEqual(['workspace note'])

    const { workspaces } = await g.listWorkspaces()
    expect(workspaces).toEqual([{ id: workspaceId, path: '/repo/app' }])
  })
})
