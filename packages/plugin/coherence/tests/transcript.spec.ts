// Transcript service behavior: idempotent ingest, incremental append, query
// filters, and credential redaction at the durable boundary.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TranscriptService } from '../src/index.ts'
import type { TranscriptMessage } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage plus the transcript service over a temp JSON root. */
async function setup(redactCredentials = true): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-transcript-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TranscriptService, { redactCredentials })
  return ctx
}

function message(messageId: string, text: string, timestamp = 1000): TranscriptMessage {
  return {
    agentType: 'claude-code',
    sessionId: 's1',
    messageId,
    role: 'user',
    timestamp,
    parts: [{ kind: 'text', text }],
  }
}

function storedSession(ctx: Context): { messageCount: number } | undefined {
  const domain = ctx.storage.form('domain').get('transcript')
  return domain?.table('sessions').get('claude-code:s1') as { messageCount: number } | undefined
}

describe('transcript service', () => {
  it('stores messages and a coherent session record', async () => {
    const ctx = await setup()
    const result = await ctx.transcript.ingest({
      agentType: 'claude-code',
      sessionId: 's1',
      messages: [message('m1', 'hello'), message('m2', 'world', 2000)],
    })
    expect(result.messagesSeen).toBe(2)
    expect(result.messagesAdded).toBe(2)
    const rows = ctx.transcript.query()
    expect(rows.map(row => row.messageId)).toEqual(['m2', 'm1'])
    expect(storedSession(ctx)?.messageCount).toBe(2)
  })

  it('is idempotent for a repeated batch', async () => {
    const ctx = await setup()
    const batch = { agentType: 'claude-code' as const, sessionId: 's1', messages: [message('m1', 'hello')] }
    const first = await ctx.transcript.ingest(batch)
    const second = await ctx.transcript.ingest(batch)
    expect(first.messagesAdded).toBe(1)
    expect(second.messagesAdded).toBe(0)
    expect((ctx.transcript.query()).length).toBe(1)
    expect(storedSession(ctx)?.messageCount).toBe(1)
  })

  it('appends new messages incrementally', async () => {
    const ctx = await setup()
    await ctx.transcript.ingest({ agentType: 'claude-code', sessionId: 's1', messages: [message('m1', 'one')] })
    await ctx.transcript.ingest({ agentType: 'claude-code', sessionId: 's1', messages: [message('m2', 'two')] })
    expect((ctx.transcript.query()).length).toBe(2)
    expect(storedSession(ctx)?.messageCount).toBe(2)
  })

  it('filters by agent, session, and keyword', async () => {
    const ctx = await setup()
    await ctx.transcript.ingest({ agentType: 'claude-code', sessionId: 's1', messages: [message('m1', 'alpha beta')] })
    await ctx.transcript.ingest({
      agentType: 'opencode',
      sessionId: 's2',
      messages: [{ ...message('m2', 'gamma delta'), agentType: 'opencode', sessionId: 's2' }],
    })
    expect(ctx.transcript.query({ agentType: 'opencode' }).length).toBe(1)
    expect(ctx.transcript.query({ sessionId: 's1' }).length).toBe(1)
    expect(ctx.transcript.query({ query: 'BETA' }).length).toBe(1)
    expect(ctx.transcript.query({ query: 'missing' }).length).toBe(0)
  })

  it('redacts credentials at the durable boundary', async () => {
    const ctx = await setup()
    await ctx.transcript.ingest({
      agentType: 'claude-code',
      sessionId: 's1',
      messages: [message('m1', 'use sk-abcdefghijklmnopqrstuvwxyz012345 to continue')],
    })
    const [row] = ctx.transcript.query()
    const first = row?.parts[0]
    const text = first?.kind === 'text' ? first.text : ''
    expect(text).toContain('sk-[REDACTED]')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('does not redact when disabled', async () => {
    const ctx = await setup(false)
    await ctx.transcript.ingest({
      agentType: 'claude-code',
      sessionId: 's1',
      messages: [message('m1', 'sk-abcdefghijklmnopqrstuvwxyz012345')],
    })
    const [row] = ctx.transcript.query()
    const first = row?.parts[0]
    const text = first?.kind === 'text' ? first.text : ''
    expect(text).toContain('abcdefghijklmnopqrstuvwxyz')
  })
})
