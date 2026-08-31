/**
 * Package-owned durable invariants of the dsh-coherence plugin. The one owned
 * event-stream ↔ mutable-data relationship asserted today is transcript
 * session coherence: a session record's `messageCount` must equal the number
 * of stored messages under its key prefix. The ingest service upholds it by
 * writing messages before the session record; the check runs only on session
 * writes so a message batch can never be observed mid-flight.
 *
 * Further owned invariants (the memory four-state transitions, codebase-map
 * `exploreRef` existence, worklog handoff ↔ direction linkage) arrive with the
 * write paths that own them; each installs a check here in the same PR.
 * @module dsh-coherence/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

const PACKAGE_NAME = 'dsh-coherence'

/** Cordis companion plugin name. */
export const name = 'dsh-coherence-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Message-key prefix shared by one session's rows (`agentType:sessionId:`). */
function sessionPrefix(agentType: string, sessionId: string): string {
  return `${agentType}:${sessionId}:`
}

/** Install the transcript session-coherence check and ignore unrelated events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'transcript' || change.table !== 'sessions' || change.operation !== 'put') return
    const domain = ctx.storage.form('domain').get('transcript')
    if (domain === undefined) {
      return fail('transcript session write emitted while the transcript domain is not open')
    }
    const record = change.value as { agentType: string; sessionId: string; messageCount: number }
    const prefix = sessionPrefix(record.agentType, record.sessionId)
    let count = 0
    for (const key of domain.table('messages').keys()) {
      if (key.startsWith(prefix)) count++
    }
    if (count !== record.messageCount) {
      return fail(
        `transcript session '${record.agentType}:${record.sessionId}' messageCount `
        + `${record.messageCount} differs from its ${count} stored messages`,
      )
    }
  }, { global: true })
}, { inject: ['storage'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
