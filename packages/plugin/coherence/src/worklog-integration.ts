/**
 * Worklog integration: injects the active work direction into the main agent's
 * prompt and records every external-subagent completion in that workspace's
 * shared work log, so the direction is visible where work happens and the log
 * traces delegation.
 * @module dsh-coherence/src/worklog-integration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { WorklogService } from './service/worklog.ts'

/** System-prompt section name and ordering of the direction block. */
export const DIRECTION_SECTION = 'worklog:direction'

/** Synchronous workspace routing key for one agent's session cwd. */
function workspaceOf(worklog: WorklogService, cwd?: string): string | undefined {
  return worklog.resolveWorkspaceIdSync(cwd)
}

/**
 * Register the `worklog:direction` prompt section. Requires the system-prompt
 * service; mount through `ctx.inject(['systemPrompt'], ...)`.
 * @param ctx - plugin context carrying the system-prompt service.
 * @param worklog - the worklog service.
 */
export function mountDirectionSection(ctx: Context, worklog: WorklogService): void {
  ctx.systemPrompt.section({
    name: DIRECTION_SECTION,
    order: 40,
    text: (context) => {
      if (context.agent === undefined) return ''
      const workspaceId = workspaceOf(worklog, context.agent.session.header.cwd)
      const direction = worklog.getActiveDirection(workspaceId)
      if (direction === undefined) return ''
      const constraints = direction.constraints.length > 0
        ? `\nConstraints: ${direction.constraints.join('; ')}`
        : ''
      return `## Current work direction\n${direction.objective}${constraints}`
    },
  })
}

/**
 * Record every external-subagent completion as a worklog milestone, routed to
 * the delegating parent's workspace.
 * @param ctx - plugin context that receives `subagent/end`.
 * @param worklog - the worklog service.
 * @returns a disposer for the listener.
 */
export function mountSubagentLogging(ctx: Context, worklog: WorklogService): () => void {
  return ctx.on('subagent/end', (info: SubagentRunEndInfo, parent?: { session?: { header?: { cwd?: string } } }) => {
    const workspaceId = workspaceOf(worklog, parent?.session?.header?.cwd)
    void worklog.log({
      text: `Subagent '${info.provider}' (${info.id}) stopped: ${info.stopReason}`,
      kind: 'milestone',
      agentType: 'main',
      sessionId: info.id,
    }, workspaceId)
  })
}
