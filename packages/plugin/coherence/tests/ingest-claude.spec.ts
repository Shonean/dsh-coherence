// Claude transcript parsing and incremental read: event normalization, non-event
// skipping, cursor advancement / unchanged-file short-circuit, and the mounted
// poller distilling an ingested session into an episodic memory.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  MemoryService,
  TranscriptService,
  captureExploration,
  fileKindForPath,
  ingestCursorSchema,
  mountClaudeIngest,
  normalizeClaudeEvent,
  readIncremental,
} from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('normalizeClaudeEvent', () => {
  it('parses a user message with text and tool blocks', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'e1',
      parentUuid: 'e0',
      timestamp: 1787669394030,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'please check' },
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        ],
      },
    })
    const message = normalizeClaudeEvent(line)
    expect(message).not.toBeNull()
    expect(message!.messageId).toBe('e1')
    expect(message!.parentId).toBe('e0')
    expect(message!.role).toBe('user')
    expect(message!.parts.map(part => part.kind)).toEqual(['text', 'tool_result'])
  })

  it('parses an assistant message with thinking and a tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [
          { type: 'thinking', thinking: 'let me plan' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } },
        ],
      },
    })
    const message = normalizeClaudeEvent(line)
    expect(message!.parts).toEqual([
      { kind: 'reasoning', text: 'let me plan' },
      { kind: 'tool_call', id: 't1', name: 'Read', arguments: { path: '/x' } },
    ])
    expect(message!.meta).toEqual({ model: 'deepseek-v4-flash' })
  })

  it('skips non-message events and malformed lines', () => {
    expect(normalizeClaudeEvent(JSON.stringify({ type: 'mode', mode: 'normal' }))).toBeNull()
    expect(normalizeClaudeEvent('not json')).toBeNull()
  })

  it('accepts a string content block', () => {
    const message = normalizeClaudeEvent(JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'plain text' },
    }))
    expect(message!.parts).toEqual([{ kind: 'text', text: 'plain text' }])
  })

  it('carries the event cwd when present', () => {
    const withCwd = normalizeClaudeEvent(JSON.stringify({
      type: 'user',
      uuid: 'u1',
      cwd: 'C:\\repo\\app',
      message: { role: 'user', content: 'one' },
    }))
    expect(withCwd!.cwd).toBe('C:\\repo\\app')
    const withoutCwd = normalizeClaudeEvent(JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'two' },
    }))
    expect(withoutCwd!.cwd).toBeUndefined()
  })
})

describe('readIncremental', () => {
  it('reads new lines and advances the cursor, then short-circuits unchanged files', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coherence-claude-'))
    const file = join(root, 'session.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'user', uuid: 'e1', message: { role: 'user', content: 'one' } }),
      '',
    ].join('\n'))

    const first = await readIncremental(file, undefined)
    expect(first.messages.length).toBe(1)
    expect(first.next.lastOffset).toBe(2)
    expect(first.next.lastModifiedMs).toBeDefined()
    // Regression: stat().mtimeMs is a float but the cursor schema requires
    // integer milliseconds; the writer must floor it so the record validates.
    expect(Number.isInteger(first.next.lastModifiedMs)).toBe(true)
    expect(() => ingestCursorSchema.parse(first.next)).not.toThrow()

    const second = await readIncremental(file, first.next)
    expect(second.messages.length).toBe(0)
  })

  it('resumes after the last processed line when the file grows', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coherence-claude-'))
    const file = join(root, 'session.jsonl')
    await writeFile(file, JSON.stringify({ type: 'user', uuid: 'e1', message: { role: 'user', content: 'one' } }))
    const first = await readIncremental(file, undefined)
    expect(first.messages.length).toBe(1)

    await writeFile(file, [
      JSON.stringify({ type: 'user', uuid: 'e1', message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'user', uuid: 'e2', message: { role: 'user', content: 'two' } }),
    ].join('\n'))
    const second = await readIncremental(file, first.next)
    expect(second.messages.length).toBe(1)
    expect(second.messages[0]?.messageId).toBe('e2')
  })

  it('extracts the project directory from the first event cwd and drops it from messages', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coherence-claude-'))
    const file = join(root, 'session.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'user', uuid: 'e1', cwd: '/repo/app', message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'assistant', uuid: 'e2', cwd: '/repo/app', message: { role: 'assistant', content: 'two' } }),
      JSON.stringify({ type: 'user', uuid: 'e3', message: { role: 'user', content: 'three' } }),
      '',
    ].join('\n'))

    const first = await readIncremental(file, undefined)
    expect(first.projectDir).toBe('/repo/app')
    for (const message of first.messages) {
      expect((message as Record<string, unknown>).cwd).toBeUndefined()
    }
    // A file without any cwd carries no projectDir at all.
    const bare = join(root, 'bare.jsonl')
    await writeFile(bare, [
      JSON.stringify({ type: 'user', uuid: 'e1', message: { role: 'user', content: 'one' } }),
      '',
    ].join('\n'))
    const second = await readIncremental(bare, undefined)
    expect(second.projectDir).toBeUndefined()
  })
})

describe('captureExploration', () => {
  it('records directory explores and file reads into the codebase map', async () => {
    const upserts: unknown[] = []
    const explores: unknown[] = []
    const codebaseMap = {
      upsert: async (node: unknown) => { upserts.push(node) },
      recordExplore: async (record: unknown) => { explores.push(record) },
    } as unknown as Parameters<typeof captureExploration>[1]

    await captureExploration([
      { messageId: 'm1', role: 'user', timestamp: 1000, parts: [{ kind: 'tool_call', id: 'call-1', name: 'Explore', arguments: { path: '/repo/src' } }] },
      { messageId: 'm2', role: 'user', timestamp: 2000, parts: [{ kind: 'tool_call', id: 'call-2', name: 'Read', arguments: { file_path: '/repo/src/index.ts' } }] },
      { messageId: 'm3', role: 'user', timestamp: 3000, parts: [{ kind: 'tool_call', id: 'call-3', name: 'Glob', arguments: { path: '/repo/tests', pattern: '**/*.test.ts' } }] },
    ] as Parameters<typeof captureExploration>[0], codebaseMap)

    expect(upserts).toHaveLength(3)
    const folder = upserts[0] as Record<string, unknown>
    const file = upserts[1] as Record<string, unknown>
    const glob = upserts[2] as Record<string, unknown>
    expect(folder.purpose).toBe('Explored by Claude Code')
    expect(folder.relativePath).toBe('/repo/src')
    expect(file.kind).toBe('source')
    expect(file.relativePath).toBe('/repo/src/index.ts')
    expect(glob.purpose).toBe('Searched by Claude Code')
    // Only Explore records an explore provenance row.
    expect(explores).toHaveLength(1)
    expect((explores[0] as Record<string, unknown>).rootPath).toBe('/repo/src')
  })

  it('classifies read files by extension and test markers', () => {
    expect(fileKindForPath('/repo/src/index.ts')).toBe('source')
    expect(fileKindForPath('/repo/README.md')).toBe('docs')
    expect(fileKindForPath('/repo/app.json')).toBe('config')
    expect(fileKindForPath('/repo/tests/foo.test.ts')).toBe('test')
  })
})

describe('mounted claude ingest', () => {
  it('ingests a session and distills it into one episodic memory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coherence-claude-e2e-'))
    const home = join(root, 'home')
    const projectsDir = join(home, 'projects', 'encoded-proj')
    await mkdir(projectsDir, { recursive: true })
    const cwd = '/repo/app'
    const file = join(projectsDir, 'sess-e2e.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'user', uuid: 'e1', cwd, timestamp: 1000, message: { role: 'user', content: 'please fix the login bug' } }),
      JSON.stringify({ type: 'assistant', uuid: 'e2', cwd, timestamp: 2000, message: { role: 'assistant', content: 'looking into it' } }),
      JSON.stringify({ type: 'user', uuid: 'e3', cwd, timestamp: 3000, message: { role: 'user', content: 'any progress?' } }),
      JSON.stringify({ type: 'assistant', uuid: 'e4', cwd, timestamp: 4000, message: { role: 'assistant', content: 'fixed and tested' } }),
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(Timer)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(TranscriptService)
    await ctx.plugin(MemoryService)

    const handle = mountClaudeIngest(
      ctx,
      ctx.get('transcript') as TranscriptService,
      { home, pollMs: 3_600_000, feedMemory: false },
      undefined,
      {},
    )
    await handle.pollNow()

    const memory = ctx.get('memory') as MemoryService
    expect(memory.stats().episodic).toBe(1)
    const [episode] = memory.list({ layer: 'episodic' })
    expect(episode).toMatchObject({ agentType: 'claude-code', sessionId: 'sess-e2e' })
    expect((episode as { summary: string }).summary).toContain('in /repo/app:')
    expect((episode as { summary: string }).summary).toContain('First request: "please fix the login bug"')
    expect((episode as { summary: string }).summary).toContain('Last reply: "fixed and tested"')
  })
})
