// Verifies the transcript-coherence invariant companion registers and accepts a
// coherent transcript write (session messageCount matching its message rows).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as MemorySuite from '../src/index.ts'
import * as MemorySuiteInvariant from 'dsh-coherence/invariant'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage, the suite, the invariant registry, and the companion. */
async function setup(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-inv-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemorySuite, MemorySuite.Config({} as MemorySuite.Config))
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(MemorySuiteInvariant)
  return ctx
}

describe('coherence transcript invariant', () => {
  it('registers the coherence companion without error', async () => {
    await setup()
  })

  it('accepts a session whose messageCount matches its stored messages', async () => {
    const ctx = await setup()
    const domain = ctx.storage.form('domain').get('transcript')
    expect(domain).toBeDefined()

    const messages = domain!.table('messages')
    const sessions = domain!.table('sessions')
    const message = {
      agentType: 'claude-code' as const,
      sessionId: 's1',
      messageId: 'm1',
      role: 'user' as const,
      timestamp: 1000,
      parts: [{ kind: 'text' as const, text: 'hello' }],
    }
    await messages.put('claude-code:s1:1000:user:0', message)
    await sessions.put('claude-code:s1', {
      agentType: 'claude-code' as const,
      sessionId: 's1',
      createdAt: 1000,
      updatedAt: 1000,
      messageCount: 1,
      source: { kind: 'file' as const, path: '/tmp/claude.jsonl' },
    })
  })
})
