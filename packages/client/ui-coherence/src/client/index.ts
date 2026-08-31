/**
 * dsh-coherence browser companion: the keyed `subagent` toolview. The host's
 * `tool-subagent` package registers the model-facing delegation tool under the
 * wire name `subagent` (configurable via `toolName`); this plugin claims that
 * key in `ui-tool`'s `tool.call.toolview` slot and renders one card per
 * delegation — the model-authored task label, lifecycle state (running /
 * failed / stopped, derived solely from the frozen call/result slice so replay
 * stays stable), a background badge for detached runs, and a bounded
 * disclosure of the delegation prompt and durable result.
 *
 * The live subagent catalog (running children, continuation) stays owned by
 * `@deepseek-ai/dsh-client-ui-subagent`; this row is its per-call transcript
 * surface.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SubagentRow } from './SubagentRow.tsx'
import { en, NS, zh, type CoherenceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated subagent tool row's copy. */
    coherence: CoherenceKey
  }
}

/** Required services: the tool-row registry and the locale registries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the keyed tool row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coherence: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'subagent', locale: NS },
    SubagentRow,
  ))
}
