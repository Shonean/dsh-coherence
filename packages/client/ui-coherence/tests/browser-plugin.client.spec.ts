/**
 * ui-coherence browser half: keyed toolview registration + locale
 * dictionaries + fiber-teardown removal (HMR safety) against the real
 * SlotRegistry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { SubagentRow } from '../src/client/SubagentRow.tsx'

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
  localeDisposed: boolean
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const capture: PresentationCapture = {
    slots,
    dictionaries: [],
    localeDisposed: false,
  }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => { capture.localeDisposed = true }
    },
    bind: () => (key: string) => key,
  })
  return capture
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the dedicated subagent row and its locale dictionaries', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = presentation.slots.entries('tool.call.toolview')[0]
    expect(entry?.options).toMatchObject({ key: 'subagent' })
    expect(entry?.locale).toBe('coherence')
    expect(entry?.component).toBe(SubagentRow)
    expect(presentation.dictionaries).toEqual([{
      namespace: 'coherence', dictionaries: {
        zh: {
          'row.title': '子 agent',
          'row.running': '子 agent 运行中',
          'row.failed': '子 agent 失败',
          'row.stopped': '子 agent 已中止',
          'row.background': '后台',
          'row.prompt': '委派提示词',
          'row.result': '结果',
        },
        en: {
          'row.title': 'Subagent',
          'row.running': 'Subagent running',
          'row.failed': 'Subagent failed',
          'row.stopped': 'Subagent stopped',
          'row.background': 'background',
          'row.prompt': 'Delegation prompt',
          'row.result': 'Result',
        },
      },
    }])
  })

  it('releases the toolview seat and locale dictionaries on fiber teardown (HMR safety)', async () => {
    const ctx = new Context()
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(1)
    await fiber.dispose()
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(presentation.localeDisposed).toBe(true)
  })
})
