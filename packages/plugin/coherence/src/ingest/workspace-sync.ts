/**
 * Workspace-open instant sync. Interval polls alone would leave a freshly
 * opened folder's external transcripts uningested for up to one poll cycle;
 * this module closes that gap: when a session is created in a registered
 * workspace, the shard manager refreshes (opening the workspace's shards) and
 * every connector runs one incremental poll immediately. Incremental cursors
 * make the extra poll cheap — unchanged sources are one stat/rowid check —
 * and idempotent, so "open the folder a second time" never re-reads it.
 * @module dsh-coherence/src/ingest/workspace-sync
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session/types'
import type { TranscriptService } from '../service/transcript.ts'
import type { IngestHandle } from './handle.ts'

/**
 * Subscribe the instant-sync path. Each connector keeps its own interval poll;
 * this only adds the event-driven trigger.
 * @param ctx - plugin context (the transcript and memory services are read
 *   from the global store; the subscription is global like every cross-plugin
 *   session listener).
 * @param handles - the mounted ingest connectors to poll.
 */
export function mountWorkspaceSync(ctx: Context, handles: readonly IngestHandle[]): void {
  const transcript = ctx.get('transcript') as TranscriptService
  let inFlight = false
  const pollAll = async (): Promise<void> => {
    // The shard manager's own contract ("refresh on every ingest poll"): a
    // workspace registered after startup opens its shards here, before the
    // poll that reads them.
    await transcript.refreshShards()
    const memory = ctx.get('memory')
    if (memory !== undefined) await memory.refreshShards()
    await Promise.all(handles.map(handle => handle.pollNow()))
  }
  ctx.on('session/created', (session) => {
    const cwd = session.header.cwd
    if (cwd === undefined || inFlight) return
    inFlight = true
    void (async () => {
      try {
        // Only a registered workspace syncs immediately; unregistered cwds
        // wait for the next interval poll (incremental cursors lose nothing).
        const workspaceId = await transcript.resolveWorkspaceId(cwd)
        if (workspaceId !== undefined) await pollAll()
      } finally {
        inFlight = false
      }
    })()
  }, { global: true })
}
