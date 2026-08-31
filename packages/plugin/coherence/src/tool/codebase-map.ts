/**
 * Model-facing codebase-map tools: `codebase_map_save`, `codebase_map_get`,
 * and `codebase_map_list`. Saving after an Explore captures structure so a later
 * session reads the map instead of re-exploring; each tool logs its
 * model-visible effect to the calling agent's session.
 * @module dsh-coherence/src/tool/codebase-map
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { CodebaseMapNode } from '../service/codebase-map.ts'
// Type-only: activates the session-events augmentation in this program.
import type {} from '../session-events.ts'

/** Cordis plugin name. */
export const name = 'tool-codebase-map'
/** The tool registry and the codebase-map service must be present. */
export const inject = ['tools', 'codebaseMap']

const SYMBOL_KINDS = ['class', 'function', 'interface', 'type', 'const', 'enum'] as const
const FILE_KINDS = ['source', 'test', 'config', 'docs', 'generated'] as const

/** Readable summary of one node for logging and output. */
function summarize(kind: 'folder' | 'file' | 'symbol', node: CodebaseMapNode, address: string): { kind: string; address: string; summary: string } {
  const summary = 'docSummary' in node ? node.docSummary : node.summary
  return { kind, address, summary }
}

/**
 * Register the codebase-map tools.
 * @param ctx - plugin context carrying the tool registry and codebase-map service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'codebase_map_save',
    description: 'Save one codebase structure node (folder, file, or symbol) to the codebase map '
      + 'so later sessions answer structure questions from the map instead of re-exploring. '
      + 'Call this after Explore or after reading a new area.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['folder', 'file', 'symbol'], description: 'Node kind.' },
      relativePath: { type: 'string', description: 'Folder or file path relative to the repo root.' },
      qualifiedName: { type: 'string', description: 'Symbol qualified name (symbol only).' },
      summary: { type: 'string', required: true, description: 'One-line summary of what this node is/does.' },
      purpose: { type: 'string', description: 'Folder purpose (folder only).' },
      keyFiles: { type: 'array', items: { type: 'string' }, description: 'Folder key files (folder only).' },
      responsibilities: { type: 'array', items: { type: 'string' }, description: 'File responsibilities (file only).' },
      fileKind: { type: 'string', enum: [...FILE_KINDS], description: 'File kind (file only).' },
      symbolKind: { type: 'string', enum: [...SYMBOL_KINDS], description: 'Symbol kind (symbol only).' },
      file: { type: 'string', description: 'Owning file of the symbol (symbol only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          address: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Saved ${value.kind} '${value.address}' to the codebase map.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('codebase_map_save requires an owning agent session')
      const workspaceId = await ctx.codebaseMap.resolveWorkspaceId(agent.session.header.cwd)
      const exploredAt = Date.now()
      let node: CodebaseMapNode
      let address: string
      if (args.kind === 'folder') {
        const relativePath = requireAddress(args.relativePath, 'relativePath')
        node = {
          relativePath,
          name: relativePath.split('/').at(-1) ?? relativePath,
          purpose: args.purpose ?? '',
          keyFiles: args.keyFiles ?? [],
          summary: args.summary,
          exploredAt,
        }
        address = relativePath
      } else if (args.kind === 'file') {
        const relativePath = requireAddress(args.relativePath, 'relativePath')
        node = {
          relativePath,
          kind: args.fileKind ?? 'source',
          summary: args.summary,
          keySymbols: [],
          responsibilities: args.responsibilities ?? [],
          exploredAt,
        }
        address = relativePath
      } else {
        const qualifiedName = requireAddress(args.qualifiedName, 'qualifiedName')
        node = {
          qualifiedName,
          kind: args.symbolKind ?? 'function',
          file: args.file ?? '',
          docSummary: args.summary,
        }
        address = qualifiedName
      }
      await ctx.codebaseMap.upsert(node, workspaceId)
      const data: SessionEventMap['codebase-map/upsert'] = { kind: args.kind, address, summary: args.summary }
      agent.session.append('codebase-map/upsert', data)
      return { kind: args.kind, address }
    },
    presentCall: args => ({ card: 'generic', title: 'Save codebase map node', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'codebase_map_get',
    description: 'Fetch one codebase structure node by address. Use this BEFORE exploring: '
      + 'if the map already covers the area, you can answer from the summary.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['folder', 'file', 'symbol'], description: 'Node kind.' },
      address: { type: 'string', required: true, description: 'Relative path (folder/file) or qualified name (symbol).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          kind: { type: 'string' },
          address: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => value.found
        ? [{ type: 'text', text: `Map hit for ${value.kind} '${value.address}': ${value.summary}` }]
        : [{ type: 'text', text: `No map entry for '${value.address}'.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('codebase_map_get requires an owning agent session')
      const workspaceId = await ctx.codebaseMap.resolveWorkspaceId(agent.session.header.cwd)
      const node = ctx.codebaseMap.get(args.address, args.kind, workspaceId)
      const data: SessionEventMap['codebase-map/read'] = {
        items: node === undefined
          ? []
          : [summarize(args.kind, node, args.address)],
      }
      agent.session.append('codebase-map/read', data)
      if (node === undefined) return { found: false }
      return {
        found: true,
        kind: args.kind,
        address: args.address,
        summary: summarize(args.kind, node, args.address).summary,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Get codebase map node', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'codebase_map_list',
    description: 'List codebase-map nodes. Use to survey what the map already covers before '
      + 'deciding what still needs Explore.',
    parameters: {
      kind: {
        type: 'string',
        enum: ['folders', 'files', 'symbols'],
        description: 'Which node tables to list; omitted lists all.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                address: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Codebase map has ${value.count} node${value.count === 1 ? '' : 's'}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('codebase_map_list requires an owning agent session')
      const workspaceId = await ctx.codebaseMap.resolveWorkspaceId(agent.session.header.cwd)
      const nodes = ctx.codebaseMap.list(args.kind === undefined ? {} : { kind: args.kind }, workspaceId)
      const kindOf = (node: CodebaseMapNode): 'folder' | 'file' | 'symbol' => (
        'qualifiedName' in node ? 'symbol' : 'purpose' in node ? 'folder' : 'file'
      )
      const items = nodes.map(node => summarize(kindOf(node), node, addressOf(node)))
      const data: SessionEventMap['codebase-map/read'] = { items }
      agent.session.append('codebase-map/read', data)
      return { count: items.length, items }
    },
    presentCall: args => ({ card: 'generic', title: 'List codebase map', kind: 'other', rawInput: args }),
  }))
}

function requireAddress(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`codebase map: '${name}' is required for this node kind`)
  }
  return value
}

function addressOf(node: CodebaseMapNode): string {
  if ('qualifiedName' in node) return node.qualifiedName
  return node.relativePath
}
