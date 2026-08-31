// Rule-based distillation: byte-stable template, threshold gating, one-shot
// per session per shard, and shard isolation.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  DISTILL_MIN_MESSAGES_DEFAULT,
  LEGACY_SHARD,
  MemoryService,
  TranscriptService,
  distillTouchedSessions,
  renderSessionEpisode,
} from '../src/index.ts'
import type { TranscriptMessage } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage + transcript + memory over a temp JSON root. */
async function setup(fakeRegistry?: { list: () => Array<{ id: string; path: string }> }): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-distill-'))
  const ctx = new Context()
  context = ctx
  if (fakeRegistry !== undefined) {
    ctx.provide('workspaceRegistry', {
      list: fakeRegistry.list,
      resolveByPath: async (path: string) => fakeRegistry.list().find(ws => path.startsWith(ws.path)),
    } as never)
  }
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TranscriptService)
  await ctx.plugin(MemoryService)
  return ctx
}

/** One stored transcript message. */
function message(
  agentType: TranscriptMessage['agentType'],
  sessionId: string,
  messageId: string,
  role: TranscriptMessage['role'],
  text: string,
  timestamp: number,
): TranscriptMessage {
  return { agentType, sessionId, messageId, role, timestamp, parts: [{ kind: 'text', text }] }
}

const START = 1_788_175_266_000
const END = 1_788_175_500_000

describe('renderSessionEpisode', () => {
  it('renders the byte-stable template', () => {
    const summary = renderSessionEpisode({
      agentType: 'claude-code',
      sessionId: 's1',
      projectDir: '/repo/app',
      messageCount: 4,
      startedAt: START,
      endedAt: END,
      firstUserText: 'fix the bug',
      lastAssistantText: 'done',
    })
    expect(summary).toBe(
      'External claude-code session s1 in /repo/app: '
      + `4 messages from ${new Date(START).toISOString()} to ${new Date(END).toISOString()}. `
      + 'First request: "fix the bug" Last reply: "done"',
    )
  })

  it('collapses whitespace and clips excerpts, so wording drift never changes the string', () => {
    const noisy = renderSessionEpisode({
      agentType: 'opencode',
      sessionId: 's2',
      messageCount: 5,
      startedAt: START,
      endedAt: END,
      firstUserText: 'fix   the\n\tbug',
      lastAssistantText: 'x'.repeat(300),
    })
    const clean = renderSessionEpisode({
      agentType: 'opencode',
      sessionId: 's2',
      messageCount: 5,
      startedAt: START,
      endedAt: END,
      firstUserText: 'fix the bug',
      lastAssistantText: 'x'.repeat(300),
    })
    expect(noisy).toBe(clean)
    expect(noisy).toContain('in an unregistered directory:')
    expect(noisy).toContain('First request: "fix the bug"')
    expect(noisy).toContain(`${'x'.repeat(120)}…"`)
    expect(noisy).not.toContain(`${'x'.repeat(121)}…"`)
  })
})

describe('distillTouchedSessions', () => {
  it('gates on the message threshold, distills once, and never re-distills', async () => {
    const ctx = await setup()
    const transcript = ctx.get('transcript') as TranscriptService
    const memory = ctx.get('memory') as MemoryService
    let nextIndex = 0
    const ingest = async (count: number): Promise<void> => {
      const base = nextIndex
      nextIndex += count
      await transcript.ingest({
        agentType: 'claude-code',
        sessionId: 's1',
        messages: Array.from({ length: count }, (_, offset) => {
          const index = base + offset
          return message('claude-code', 's1', `m${index}`, index % 2 === 0 ? 'user' : 'assistant', `text ${index}`, START + index)
        }),
      })
    }

    // Below the threshold: nothing distills.
    await ingest(DISTILL_MIN_MESSAGES_DEFAULT - 1)
    const below = await distillTouchedSessions(
      [{ agentType: 'claude-code', sessionId: 's1', shard: LEGACY_SHARD }],
      transcript, memory,
    )
    expect(below).toBe(0)
    expect(memory.stats().episodic).toBe(0)

    // Reaching the threshold: exactly one episode with the template content.
    await ingest(2)
    const at = await distillTouchedSessions(
      [{ agentType: 'claude-code', sessionId: 's1', shard: LEGACY_SHARD }],
      transcript, memory,
    )
    expect(at).toBe(1)
    expect(memory.stats().episodic).toBe(1)
    const [episode] = memory.list({ layer: 'episodic' })
    expect(episode).toMatchObject({ layer: 'episodic', agentType: 'claude-code', sessionId: 's1' })
    expect((episode as { summary: string }).summary).toContain('5 messages from')

    // A later poll of the same session short-circuits.
    await ingest(2)
    const again = await distillTouchedSessions(
      [{ agentType: 'claude-code', sessionId: 's1', shard: LEGACY_SHARD }],
      transcript, memory,
    )
    expect(again).toBe(0)
    expect(memory.stats().episodic).toBe(1)
    expect(transcript.readDistill('claude-code', 's1')).toBeDefined()
  })

  it('keeps distill state sharded with the session', async () => {
    const workspaceId = 'a'.repeat(32)
    const ctx = await setup({ list: () => [{ id: workspaceId, path: '/repo/app' }] })
    const transcript = ctx.get('transcript') as TranscriptService
    const memory = ctx.get('memory') as MemoryService

    // Same session id in two shards: legacy (no projectDir) and the workspace.
    const batch = (sessionId: string, projectDir: string | undefined) => ({
      agentType: 'claude-code' as const,
      sessionId,
      messages: [
        message('claude-code', sessionId, 'm0', 'user', 'hello', START),
        message('claude-code', sessionId, 'm1', 'assistant', 'hi there', START + 1),
        message('claude-code', sessionId, 'm2', 'user', 'do it', START + 2),
        message('claude-code', sessionId, 'm3', 'assistant', 'done', START + 3),
      ],
      meta: {
        source: { kind: 'file' as const, path: `/x/${sessionId}.jsonl` },
        ...(projectDir === undefined ? {} : { projectDir }),
      },
    })
    const legacy = await transcript.ingest(batch('shared', undefined))
    const workspace = await transcript.ingest(batch('shared', '/repo/app'))
    expect(legacy.shard).toBe(LEGACY_SHARD)
    expect(workspace.shard).toBe(workspaceId)

    const written = await distillTouchedSessions([
      { agentType: 'claude-code', sessionId: 'shared', shard: legacy.shard },
      { agentType: 'claude-code', sessionId: 'shared', shard: workspace.shard },
    ], transcript, memory)
    expect(written).toBe(2)
    expect(memory.stats().episodic).toBe(1)
    expect(memory.stats(workspaceId).episodic).toBe(1)
    expect(transcript.readDistill('claude-code', 'shared')).toBeDefined()
    expect(transcript.readDistill('claude-code', 'shared', workspaceId)).toBeDefined()
  })

  it('feeds consolidation: a distilled episode becomes exactly one semantic claim', async () => {
    const ctx = await setup()
    const transcript = ctx.get('transcript') as TranscriptService
    const memory = ctx.get('memory') as MemoryService
    await transcript.ingest({
      agentType: 'opencode',
      sessionId: 'ses_9',
      messages: [
        message('opencode', 'ses_9', 'm0', 'user', 'migrate the storage layer', START),
        message('opencode', 'ses_9', 'm1', 'assistant', 'on it', START + 1),
        message('opencode', 'ses_9', 'm2', 'user', 'how far?', START + 2),
        message('opencode', 'ses_9', 'm3', 'assistant', 'finished', START + 3),
      ],
    })
    await distillTouchedSessions(
      [{ agentType: 'opencode', sessionId: 'ses_9', shard: LEGACY_SHARD }],
      transcript, memory,
    )
    const report = await memory.consolidate()
    expect(report.episodesConsolidated).toBe(1)
    expect(report.claimsAdded).toBe(1)
    expect(memory.stats().semantic).toBe(1)
    const [claim] = memory.list({ layer: 'semantic' })
    expect((claim as { subject: string }).subject).toBe('opencode')
    expect((claim as { claim: string }).claim).toContain('migrate the storage layer')
  })
})
