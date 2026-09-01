/**
 * Offline memory consolidation as a background job: replays active episodes
 * into semantic claims through {@link MemoryService.consolidate}. Registered as
 * the `memory-consolidation` job kind; the trigger (interval or explicit tool)
 * starts a job only when the job registry is composed, falling back to a direct
 * call otherwise.
 * @module dsh-coherence/src/service/consolidation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobId, JobOutcome, JobStart } from '@deepseek-ai/dsh-jobs'
import type { MemoryService } from './memory.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'memory-consolidation': 'memory-consolidation'
  }
}

/**
 * Start one consolidation job on the registry.
 * @param jobs - the job registry (`ctx.jobs`).
 * @param memory - the memory service.
 * @returns the issued job id.
 */
export function startConsolidationJob(
  jobs: { start(spec: JobStart): JobId },
  memory: MemoryService,
): JobId {
  return jobs.start({
    kind: 'memory-consolidation',
    label: 'Consolidating episodic memory into semantic claims',
    run() {
      let settle!: (outcome: JobOutcome) => void
      const done = new Promise<JobOutcome>((resolve) => { settle = resolve })
      void memory.consolidateAll()
        .then((reports) => {
          const episodes = reports.reduce((sum, report) => sum + report.episodesConsolidated, 0)
          const claims = reports.reduce((sum, report) => sum + report.claimsAdded, 0)
          settle({
            status: 'completed',
            output: `${episodes} episodes, ${claims} claims added across ${reports.length} shard(s)`,
          })
        })
        .catch((error: unknown) => {
          settle({
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          })
        })
      return {
        // The consolidation is short and bounded; a cancel is a no-op that lets
        // the in-flight run settle and the registry observe `completed`.
        cancel: () => {},
        done,
      }
    },
  })
}

/**
 * Run one consolidation, through a job when the registry serves this context,
 * directly otherwise.
 * @param ctx - plugin context.
 * @param memory - the memory service.
 * @returns resolution after consolidation settles.
 */
export function runConsolidation(ctx: Context, memory: MemoryService): Promise<void> {
  const jobs = ctx.get('jobs')
  if (jobs !== undefined) {
    try {
      startConsolidationJob(jobs, memory)
      return Promise.resolve()
    } catch {
      // A composed-but-unserved registry (an owner agent whose composition
      // loads no job controller) rejects `start()`; the consolidation itself
      // must still run, so degrade to the direct call the no-registry path
      // uses.
    }
  }
  return memory.consolidateAll().then(() => {})
}
