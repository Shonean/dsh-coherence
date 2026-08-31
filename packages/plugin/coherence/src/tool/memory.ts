/**
 * Model-facing memory tools: `memory_write`, `memory_recall`, `memory_forget`,
 * and `memory_status`. Each logs its model-visible effect to the calling
 * agent's session (Model-visible ⟺ logged); a caller without an owning session
 * is rejected.
 * @module dsh-coherence/src/tool/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { MemoryLayer, MemoryRecallQuery, MemoryWriteInput } from '../service/memory.ts'
// Type-only: activates the session-events augmentation in this program.
import type {} from '../session-events.ts'

/** Cordis plugin name. */
export const name = 'tool-memory'
/** The tool registry and the memory service must be present. */
export const inject = ['tools', 'memory']

const LAYERS: MemoryLayer[] = ['working', 'episodic', 'semantic']

/**
 * Register the memory tools.
 * @param ctx - plugin context carrying the tool registry and memory service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Store one entry in the three-layer memory. `working` holds current '
      + 'session facts, `episodic` a concrete recent episode, `semantic` a consolidated '
      + 'long-term claim. Prefer semantic for stable knowledge; a semantic write with the '
      + 'same `subject` as an existing active claim marks that claim contradicted and stores '
      + 'the new claim tentative.',
    parameters: {
      layer: {
        type: 'string',
        required: true,
        enum: [...LAYERS],
        description: 'Which memory layer to write.',
      },
      content: { type: 'string', required: true, description: 'The fact, episode summary, or claim to remember.' },
      subject: { type: 'string', description: 'Semantic subject used for dedup and conflict detection.' },
      importance: { type: 'number', description: '0..1 relevance weight; higher wins recall.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for later filtering.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: { type: 'string', required: true },
          ref: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Stored ${value.layer} memory entry.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_write requires an owning agent session')
      const workspaceId = await ctx.memory.resolveWorkspaceId(agent.session.header.cwd)
      const input: MemoryWriteInput = { layer: args.layer, content: args.content }
      if (args.subject !== undefined) input.subject = args.subject
      if (args.importance !== undefined) input.importance = args.importance
      if (args.tags !== undefined) input.tags = args.tags
      const ref = await ctx.memory.write(input, workspaceId)
      const data: SessionEventMap['memory/write'] = { layer: ref.layer, ref: ref.key, content: args.content }
      if (args.importance !== undefined) data.importance = args.importance
      if (args.tags !== undefined) data.tags = args.tags
      agent.session.append('memory/write', data)
      return { layer: ref.layer, ref: ref.key }
    },
    presentCall: args => ({ card: 'generic', title: 'Write memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Recall the most relevant stored memory entries across layers. '
      + 'Use before answering a question that earlier sessions or agents may have '
      + 'recorded. Results exclude superseded or contradicted entries.',
    parameters: {
      query: { type: 'string', description: 'Free-text keyword; empty recalls by recency and importance.' },
      maxTokens: { type: 'integer', description: 'Total recall budget; split across layers.' },
      layers: {
        type: 'array',
        items: { type: 'string', enum: [...LAYERS] },
        description: 'Layers to search; defaults to all three.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                layer: { type: 'string', required: true },
                ref: { type: 'string', required: true },
                content: { type: 'string', required: true },
                subject: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recalled ${value.items.length} memory entr${value.items.length === 1 ? 'y' : 'ies'}.`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_recall requires an owning agent session')
      const workspaceId = await ctx.memory.resolveWorkspaceId(agent.session.header.cwd)
      const query: MemoryRecallQuery = {}
      if (args.query !== undefined) query.query = args.query
      if (args.maxTokens !== undefined) query.maxTokens = args.maxTokens
      if (args.layers !== undefined) query.layers = args.layers
      if (workspaceId !== undefined) query.workspaceId = workspaceId
      const result = ctx.memory.recall(query)
      const items: Array<{ layer: string; ref: string; content: string; subject?: string }> = result.items.map(item => (
        item.subject === undefined
          ? { layer: item.layer, ref: item.key, content: item.content }
          : { layer: item.layer, ref: item.key, content: item.content, subject: item.subject }
      ))
      agent.session.append('memory/recall', {
        query: args.query ?? '',
        items: items.map(item => ({ layer: item.layer, key: item.ref, content: item.content })),
      })
      return { items }
    },
    presentCall: args => ({ card: 'generic', title: 'Recall memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Soft-delete one stored memory entry by marking it outdated, so recall '
      + 'stops returning it. The record remains in storage for auditability.',
    parameters: {
      layer: { type: 'string', required: true, enum: [...LAYERS], description: 'Which layer the entry lives in.' },
      ref: { type: 'string', required: true, description: 'The entry reference returned by write or recall.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Forgot memory entry ${value.ref}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_forget requires an owning agent session')
      const workspaceId = await ctx.memory.resolveWorkspaceId(agent.session.header.cwd)
      await ctx.memory.forget({ layer: args.layer, key: args.ref }, workspaceId)
      agent.session.append('memory/forget', { layer: args.layer, ref: args.ref, state: 'outdated' })
      return { ref: args.ref }
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_consolidate',
    description: 'Run the offline consolidation now: replay active episodic entries into '
      + 'consolidated semantic claims and mark the replayed episodes superseded.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          episodesConsolidated: { type: 'integer', required: true },
          claimsAdded: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Consolidated ${value.episodesConsolidated} episodes into ${value.claimsAdded} semantic claims.`,
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_consolidate requires an owning agent session')
      const workspaceId = await ctx.memory.resolveWorkspaceId(agent.session.header.cwd)
      const report = await ctx.memory.consolidate(workspaceId)
      agent.session.append('memory/consolidate', { episodes: report.episodesConsolidated, claims: report.claimsAdded })
      return { episodesConsolidated: report.episodesConsolidated, claimsAdded: report.claimsAdded }
    },
    presentCall: () => ({ card: 'generic', title: 'Consolidate memory', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_status',
    description: 'Report how many entries each memory layer currently holds.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          working: { type: 'integer', required: true },
          episodic: { type: 'integer', required: true },
          semantic: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Memory: ${value.working} working, ${value.episodic} episodic, ${value.semantic} semantic.`,
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('memory_status requires an owning agent session')
      const workspaceId = await ctx.memory.resolveWorkspaceId(agent.session.header.cwd)
      const stats = ctx.memory.stats(workspaceId)
      agent.session.append('memory/status', stats)
      return stats
    },
    presentCall: () => ({ card: 'generic', title: 'Memory status', kind: 'other', rawInput: {} }),
  }))
}
