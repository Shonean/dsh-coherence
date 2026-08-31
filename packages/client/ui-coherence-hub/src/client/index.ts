/** Coherence Hub: the conversation-view tab over the coherence suite's data. */
import type { ClientContext, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// The coherence wire rows and the ctx.remote.coherence Remote namespace are
// owned by this suite's host plugin. The monorepo's client Remote aggregate
// (api-remotes) ships without the coherence faces in standalone, so read the
// rows from the local plugin's /types face and pull its Remote merge from /remote.
import type {
  CoherenceMemoryListResult,
  CoherenceRecallResult,
  CoherenceStatsResult,
  CoherenceWorkspacesResult,
} from 'dsh-coherence/types'
import type {} from 'dsh-coherence/remote'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CoherenceHubView, type CoherenceHubInjected } from './HubView.tsx'
import { en, zh, type CoherenceHubLocaleKey } from './locales.ts'

export type { CoherenceHubInjected, CoherenceHubViewProps } from './HubView.tsx'
export type { CoherenceHubLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Coherence Hub copy. */
    'coherenceHub': CoherenceHubLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'coherenceHub'

/** Required services: the conversation slot ring, session navigation, the locale service, and the wire API. */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.coherence', 'connection']

/** Unwrap one typed Remote envelope, failing loud on the error arm. */
function unwrap<T>(response: RemoteResult<T>): T {
  if (!response.ok) {
    throw new Error(`remote.coherence failed: ${response.error.code}: ${response.error.message}`)
  }
  return response.value
}

/** Unwrap one unary RPC result, failing loud on the error arm. */
function unwrapRpc<T>(result: RpcResult<T>): T {
  if (!result.ok) {
    throw new Error(`subagent rpc failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

/**
 * Continuable-delegation slice of the host `subagents` RPC API. `providers` and
 * `startContinuable` ship in the host after the pinned client Remote aggregate
 * (0.1.1-rc.2), so the consumed slice is declared locally rather than read from
 * the aggregate's (older) `api.subagents` surface. `interrupt` already ships in
 * the pinned aggregate and stays called on `api.subagents` directly.
 */
/** Unary connection call envelope: the response carries the RPC result. */
type RpcResponseOf<T> = { result: RpcResult<T> }

type DelegationSubagents = {
  providers: (payload: Record<string, never>) => Promise<RpcResponseOf<{
    providers: Array<{ name: string; continuable: boolean }>
  }>>
  startContinuable: (
    payload: { parentSessionId: SessionId; provider: string; label: string; prompt: string },
    signal: AbortSignal,
  ) => Promise<RpcResponseOf<{ childId: SessionId; messageId: string }>>
}

/**
 * Client plugin body: register the Coherence tab in the conversation view ring.
 * The registration rides the slot service's effect wrapper, so plugin unload
 * removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coherence-hub: dictionaries')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.sessions
  const api = (ctx.get('connection') as ConnectionHandle).api
  // Post-rc.2 delegation RPCs (see DelegationSubagents); read through the local
  // slice type. `interrupt` is pinned-shipping and stays on api.subagents.
  const delegation = api.subagents as unknown as DelegationSubagents
  const injected = (): CoherenceHubInjected => ({
    stats: async args => unwrap<CoherenceStatsResult>(await ctx.remote.coherence.stats(args)),
    listMemory: async args => unwrap<CoherenceMemoryListResult>(await ctx.remote.coherence.listMemory(args)),
    recallMemory: async args => unwrap<CoherenceRecallResult>(await ctx.remote.coherence.recallMemory(args)),
    listWorkspaces: async () => unwrap<CoherenceWorkspacesResult>(await ctx.remote.coherence.listWorkspaces()),
    providers: async () => unwrapRpc((await delegation.providers({})).result),
    startDelegation: async args => unwrapRpc((await delegation.startContinuable(args, new AbortController().signal)).result),
    interruptChild: async (address: SubagentAddress & { mode: 'continuable' }) =>
      unwrapRpc((await api.subagents.interrupt(address)).result),
    openChild: (address: SubagentAddress) => { sessions.openSubagent(address) },
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'coherence',
    order: 20,
    locale: NS,
    label: () => t('view'),
    inject: injected,
  }, CoherenceHubView))
}
