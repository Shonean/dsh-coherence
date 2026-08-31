/**
 * Shared ingest-connector mount contract.
 * @module dsh-coherence/src/ingest/handle
 */

/**
 * One mounted ingest connector's handle. The interval poll stays lifecycle-
 * managed by the timer service; `pollNow` is the immediate incremental-poll
 * entry the workspace-sync path (`session/created`) calls to pull a freshly
 * opened folder's transcripts in ahead of the next interval tick.
 */
export interface IngestHandle {
  /** Stop the interval poll (also owned by the timer service). */
  dispose(): void
  /**
   * Run one incremental poll immediately. When a poll is already in flight the
   * returned promise resolves with that run; incremental cursors make skipping
   * or repeating a tick equally safe.
   */
  pollNow(): Promise<void>
}
