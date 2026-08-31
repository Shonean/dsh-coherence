// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { CoherenceHubView } from '../src/client/HubView.tsx'
import type { CoherenceHubInjected } from '../src/client/HubView.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY_STATS = {
  memory: { working: 0, episodic: 0, semantic: 0 },
  ingest: [],
}

async function bench(remote: {
  stats?: () => Promise<unknown>
  listMemory?: () => Promise<unknown>
  recallMemory?: () => Promise<unknown>
}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class SessionsService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'sessions')
    }
    openSubagent = vi.fn()
  }
  new SessionsService(ctx)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  // The delegation form reads the wire API through the connection handle.
  ctx.provide('connection', { api: { subagents: { providers: vi.fn(), startContinuable: vi.fn(), interrupt: vi.fn() } } })
  const stats = vi.fn(remote.stats ?? (async () => ({ ok: true as const, value: EMPTY_STATS })))
  const listMemory = vi.fn(remote.listMemory ?? (async () => ({ ok: true as const, value: { entries: [] } })))
  ctx.provide('remote.coherence', { stats, listMemory, recallMemory: vi.fn(), listWorkspaces: vi.fn() })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, sessions: ctx.get('sessions') as unknown as SessionsService, stats, listMemory }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  } as never, () => null)
}

describe('ui-coherence-hub browser plugin', () => {
  it('declares the services the Hub reads through', () => {
    expect(inject).toEqual(['slots', 'sessions', 'locale', 'remote', 'remote.coherence', 'connection'])
  })

  it('registers the localized coherence view without reading the Remote eagerly', async () => {
    const b = await bench({})
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('conversation.view')[0]!
    expect(entry.component).toBe(CoherenceHubView)
    expect(entry.options).toMatchObject({ id: 'coherence', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('Coherence')
    expect(b.stats).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
    expect(b.slots.entries('conversation.view')).toHaveLength(0)
  })

  it('unwraps the Remote envelope and fails loud on the error arm', async () => {
    const b = await bench({
      stats: async () => ({ ok: true as const, value: EMPTY_STATS }),
      listMemory: async () => ({ ok: false as const, error: { code: 'REMOTE_ERROR', message: 'unavailable' } }),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('conversation.view')[0]!
    const injected = (entry.inject as unknown as () => CoherenceHubInjected)()
    await expect(injected.stats({})).resolves.toEqual(EMPTY_STATS)
    await expect(injected.listMemory({ limit: 10 })).rejects.toThrow('remote.coherence failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })
})
