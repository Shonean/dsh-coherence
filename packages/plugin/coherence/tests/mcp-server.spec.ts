// MCP bridge end-to-end over an in-memory transport: tool registration, a real
// memory_write → memory_recall round trip, the enabled-tools whitelist, and
// the worklog tools (workspace-scoped, undefined-result-safe).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { MemoryService, WorklogService, registerTools } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage + memory + worklog, register the MCP tools, and connect a client. */
async function connect(enabledTools: string[] = []): Promise<Client> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-mcp-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService)
  await ctx.plugin(WorklogService)
  const mcp = new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: {} } })
  const memory = ctx.get('memory')
  if (memory === undefined) throw new Error('memory service missing')
  const worklog = ctx.get('worklog')
  if (worklog === undefined) throw new Error('worklog service missing')
  registerTools(mcp, { memory, worklog }, new Set(enabledTools))
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1' })
  await client.connect(clientTransport)
  return client
}

describe('mcp server bridge', () => {
  it('registers the memory tools', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_recall')
    expect(names).toContain('memory_status')
  })

  it('round-trips memory_write through memory_recall', async () => {
    const client = await connect()
    const write = await client.callTool({
      name: 'memory_write',
      arguments: { layer: 'working', content: 'the bridge works over mcp', importance: 0.9 },
    }) as { content: Array<{ type: string; text?: string }> }
    expect(write.content[0]?.type).toBe('text')
    const recall = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'mcp' },
    }) as { content: Array<{ type: string; text?: string }> }
    const text = recall.content[0]?.type === 'text' ? recall.content[0].text : ''
    expect(text).toContain('bridge works')
  })

  it('applies the enabled-tools whitelist', async () => {
    const client = await connect(['memory_status'])
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['memory_status'])
  })

  it('round-trips worklog_log through worklog_get_direction and never emits a bare undefined', async () => {
    const client = await connect()

    // Regression: an absent direction used to serialize to a `text: undefined`
    // content item that failed the SDK's own result validation.
    const empty = await client.callTool({ name: 'worklog_get_direction', arguments: {} }) as {
      content: Array<{ type: string; text?: string }>
    }
    expect(empty.content[0]?.type).toBe('text')
    expect(typeof empty.content[0]?.text).toBe('string')

    const logged = await client.callTool({
      name: 'worklog_log',
      arguments: { text: 'bridge logs land in the kernel workspace shard', kind: 'decision' },
    }) as { content: Array<{ type: string; text?: string }> }
    expect(logged.content[0]?.type === 'text' && typeof logged.content[0]?.text).toBe('string')

    const listed = await client.callTool({ name: 'worklog_list', arguments: {} }) as {
      content: Array<{ type: string; text?: string }>
    }
    const listText = listed.content[0]?.type === 'text' ? listed.content[0].text ?? '' : ''
    expect(listText).toContain('bridge logs land in the kernel workspace shard')
  })
})
