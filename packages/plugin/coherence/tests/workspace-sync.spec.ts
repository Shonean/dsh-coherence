// Workspace-open instant sync: a session created inside a registered workspace
// triggers refresh + pollNow; unregistered cwds and concurrent triggers do not.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TranscriptService, mountWorkspaceSync } from '../src/index.ts'
import type { IngestHandle } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const WORKSPACE_ID = 'a'.repeat(32)
const WORKSPACE_PATH = '/repo/app'

/** Mount the storage stack under a registry that resolves (or slowly resolves) the workspace. */
async function setup(resolveDelayMs = 0): Promise<{ polls: Promise<void>[] }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-sync-'))
  const ctx = new Context()
  context = ctx
  ctx.provide('workspaceRegistry', {
    list: () => [{ id: WORKSPACE_ID, path: WORKSPACE_PATH }],
    resolveByPath: async (path: string) => {
      if (resolveDelayMs > 0) await new Promise(resolve => setTimeout(resolve, resolveDelayMs))
      return path.startsWith(WORKSPACE_PATH) ? { id: WORKSPACE_ID, path: WORKSPACE_PATH } : undefined
    },
  } as never)
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(TranscriptService)

  const polls: Promise<void>[] = []
  const handle: IngestHandle = {
    dispose: () => {},
    pollNow: () => {
      const poll = Promise.resolve()
      polls.push(poll)
      return poll
    },
  }
  mountWorkspaceSync(ctx, [handle])
  return { polls }
}

/** One created session carrying the cwd its agent will work in. */
function createdSession(cwd: string): unknown {
  return { header: { cwd } }
}

describe('workspace sync', () => {
  it('polls immediately when a session opens inside a registered workspace', async () => {
    const { polls } = await setup()
    context!.emit('session/created', createdSession(`${WORKSPACE_PATH}/nested`) as never)
    await vi.waitFor(() => { expect(polls.length).toBe(1) })
  })

  it('does nothing for an unregistered cwd', async () => {
    const { polls } = await setup()
    context!.emit('session/created', createdSession('/elsewhere/other') as never)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(polls.length).toBe(0)
  })

  it('does nothing for a session without a cwd', async () => {
    const { polls } = await setup()
    context!.emit('session/created', { header: {} } as never)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(polls.length).toBe(0)
  })

  it('merges concurrent triggers into one sync', async () => {
    const { polls } = await setup(30)
    context!.emit('session/created', createdSession(WORKSPACE_PATH) as never)
    context!.emit('session/created', createdSession(`${WORKSPACE_PATH}/sub`) as never)
    await vi.waitFor(() => { expect(polls.length).toBe(1) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(polls.length).toBe(1)
  })

  it('opens the workspace shard so the poll lands in it, not in legacy', async () => {
    await setup()
    const transcript = context!.get('transcript') as TranscriptService
    context!.emit('session/created', createdSession(WORKSPACE_PATH) as never)
    await vi.waitFor(async () => {
      // Before the sync, an unopened shard falls back to legacy; after it, the
      // workspace shard exists and ingest resolves there without a refresh.
      const result = await transcript.ingest({
        agentType: 'claude-code',
        sessionId: 'ws-session',
        messages: [{
          agentType: 'claude-code', sessionId: 'ws-session', messageId: 'm1', role: 'user',
          timestamp: 1, parts: [{ kind: 'text', text: 'hello' }],
        }],
        meta: { projectDir: WORKSPACE_PATH },
      })
      expect(result.shard).toBe(WORKSPACE_ID)
    })
  })
})
