/**
 * Model-facing worklog tools: `worklog_get_direction`, `worklog_update_direction`,
 * `worklog_log`, and `worklog_list`. These make the shared direction document and
 * work-log readable and writable by the main agent and (through the MCP bridge)
 * every external agent.
 * @module dsh-coherence/src/tool/worklog
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { WorklogEntry } from '../domain/worklog.ts'
import type { DirectionUpdate, WorklogEntryInput } from '../service/worklog.ts'
// Type-only: activates the session-events augmentation in this program.
import type {} from '../session-events.ts'

/** Cordis plugin name. */
export const name = 'tool-worklog'
/** The tool registry and the worklog service must be present. */
export const inject = ['tools', 'worklog']

/**
 * Register the worklog tools.
 * @param ctx - plugin context carrying the tool registry and worklog service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'worklog_get_direction',
    description: 'Return the current work direction (objective, constraints, owner) shared across '
      + 'agents. Read this at the start of a task to align with the active plan.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          directionId: { type: 'string' },
          title: { type: 'string' },
          objective: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => value.found
        ? [{ type: 'text', text: `Current direction: ${value.objective}` }]
        : [{ type: 'text', text: 'No active work direction set.' }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('worklog_get_direction requires an owning agent session')
      const workspaceId = await ctx.worklog.resolveWorkspaceId(agent.session.header.cwd)
      const direction = ctx.worklog.getActiveDirection(workspaceId)
      const data: SessionEventMap['worklog/read'] = {
        items: direction === undefined ? [] : [{ key: direction.directionId, text: direction.objective }],
      }
      agent.session.append('worklog/read', data)
      if (direction === undefined) return { found: false }
      return {
        found: true,
        directionId: direction.directionId,
        title: direction.title,
        objective: direction.objective,
        constraints: direction.constraints,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Get work direction', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_update_direction',
    description: 'Set the shared work direction. Creating a new direction supersedes the previous '
      + 'active one. Every agent that reads the direction will see this next.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title for the direction.' },
      objective: { type: 'string', required: true, description: 'What we are trying to achieve.' },
      directionId: { type: 'string', description: 'Update an existing direction instead of creating one.' },
      scope: { type: 'string', description: 'What is in scope.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Hard constraints.' },
      priority: { type: 'number', description: '0..1 priority.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Work direction ${value.directionId} set.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('worklog_update_direction requires an owning agent session')
      const update: DirectionUpdate = { title: args.title, objective: args.objective, updatedBy: 'main' }
      if (args.directionId !== undefined) update.directionId = args.directionId
      if (args.scope !== undefined) update.scope = args.scope
      if (args.constraints !== undefined) update.constraints = args.constraints
      if (args.priority !== undefined) update.priority = args.priority
      const workspaceId = await ctx.worklog.resolveWorkspaceId(agent.session.header.cwd)
      const directionId = await ctx.worklog.updateDirection(update, workspaceId)
      const data: SessionEventMap['worklog/update'] = { action: 'direction', key: directionId }
      agent.session.append('worklog/update', data)
      return { directionId }
    },
    presentCall: args => ({ card: 'generic', title: 'Update work direction', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_log',
    description: 'Append one line to the shared work log: a milestone reached, a decision made, or '
      + 'a note that should outlive this session.',
    parameters: {
      text: { type: 'string', required: true, description: 'The log line.' },
      kind: { type: 'string', enum: ['log', 'milestone', 'decision', 'handoff', 'explore'], description: 'Entry kind.' },
      directionId: { type: 'string', description: 'Direction this entry belongs to.' },
      refs: { type: 'array', items: { type: 'string' }, description: 'Referenced keys (sessions, memory, files).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entryId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Logged worklog entry ${value.entryId}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('worklog_log requires an owning agent session')
      const entry: WorklogEntryInput = { text: args.text }
      if (args.kind !== undefined) entry.kind = args.kind
      if (args.directionId !== undefined) entry.directionId = args.directionId
      if (args.refs !== undefined) entry.refs = args.refs
      const workspaceId = await ctx.worklog.resolveWorkspaceId(agent.session.header.cwd)
      const entryId = await ctx.worklog.log(entry, workspaceId)
      const data: SessionEventMap['worklog/update'] = { action: 'entry', key: entryId }
      agent.session.append('worklog/update', data)
      return { entryId }
    },
    presentCall: args => ({ card: 'generic', title: 'Log worklog entry', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'worklog_list',
    description: 'List recent shared work-log entries. Use to see what has been done and by which agent.',
    parameters: {
      kind: { type: 'string', enum: ['log', 'milestone', 'decision', 'handoff', 'explore'], description: 'Filter by kind.' },
      directionId: { type: 'string', description: 'Filter by direction.' },
      limit: { type: 'integer', description: 'Max entries (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entryId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                agentType: { type: 'string' },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.entries.length} worklog entr${value.entries.length === 1 ? 'y' : 'ies'}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('worklog_list requires an owning agent session')
      const workspaceId = await ctx.worklog.resolveWorkspaceId(agent.session.header.cwd)
      const filter: { kind?: WorklogEntry['kind']; directionId?: string } = {}
      if (args.kind !== undefined) filter.kind = args.kind
      if (args.directionId !== undefined) filter.directionId = args.directionId
      const entries = ctx.worklog.listEntries(filter, workspaceId).slice(0, args.limit ?? 50)
      const items = entries.map(entry => ({ key: entry.entryId, text: entry.text }))
      const data: SessionEventMap['worklog/read'] = { items }
      agent.session.append('worklog/read', data)
      return {
        entries: entries.map(entry => (
          entry.agentType === undefined
            ? { entryId: entry.entryId, kind: entry.kind, text: entry.text }
            : { entryId: entry.entryId, kind: entry.kind, agentType: entry.agentType, text: entry.text }
        )),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'List worklog', kind: 'other', rawInput: args }),
  }))
}
