// MCP bridge end-to-end over real HTTP: the Streamable HTTP transport, two
// concurrent client sessions (the per-session transport regression — one
// shared transport made a second initialize report "already initialized"),
// and a codebase-map round trip through the mounted server.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CodebaseMapService, mountMcpServer, type McpServerMount } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let mount: McpServerMount | undefined

afterEach(async () => {
  mount?.close()
  await context?.fiber.dispose()
  context = undefined
  mount = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot storage + the codebase map and mount the HTTP MCP server on a free port. */
async function boot(): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-mcp-http-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(CodebaseMapService)
  const codebaseMap = ctx.get('codebaseMap')
  if (codebaseMap === undefined) throw new Error('codebaseMap service missing')
  await codebaseMap.upsert({
    relativePath: 'packages/memory',
    name: 'memory',
    purpose: 'Explored by the HTTP e2e probe',
    keyFiles: [],
    summary: 'Memory subsystem directory.',
    exploredAt: 1_700_000_000_000,
  })
  mount = await mountMcpServer(ctx, {
    transport: 'streamable-http',
    port: 0,
    path: '/mcp',
    enabledTools: [],
  })
  return { ctx, port: mount.port }
}

/** Connect one real SDK client over Streamable HTTP and finish initialize. */
async function connectClient(port: number, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  const client = new Client({ name, version: '1' })
  // The SDK transport declares an explicit `sessionId: string | undefined`,
  // which exactOptionalPropertyTypes rejects at the Transport boundary.
  await client.connect(transport as unknown as Transport)
  return client
}

describe('mcp server over HTTP', () => {
  it('serves tools/list and codebase_map round trips', async () => {
    const { port } = await boot()
    const client = await connectClient(port, 'http-probe')
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    expect(names).toContain('codebase_map_list')
    expect(names).toContain('codebase_map_get')

    const listed = await client.callTool({ name: 'codebase_map_list', arguments: { kind: 'folders' } }) as {
      content: Array<{ type: string; text?: string }>
    }
    const payload = JSON.parse(listed.content[0]?.text ?? '[]') as unknown
    expect(Array.isArray(payload)).toBe(true)
    expect(JSON.stringify(payload)).toContain('packages/memory')

    const fetched = await client.callTool({
      name: 'codebase_map_get',
      arguments: { kind: 'folder', address: 'packages/memory' },
    }) as { content: Array<{ type: string; text?: string }> }
    const node = JSON.parse(fetched.content[0]?.text ?? 'null') as { name?: string } | null
    expect(node?.name).toBe('memory')
  })

  it('accepts a second client session after the first initialized (per-session transport)', async () => {
    const { port } = await boot()
    const first = await connectClient(port, 'http-probe-1')
    expect((await first.listTools()).tools.length).toBeGreaterThan(0)
    // The regression: a shared server transport locked the endpoint to one
    // session and the second initialize failed with "already initialized".
    const second = await connectClient(port, 'http-probe-2')
    expect((await second.listTools()).tools.length).toBeGreaterThan(0)
    const listed = await second.callTool({
      name: 'codebase_map_list',
      arguments: { kind: 'folders' },
    }) as { content: Array<{ type: string; text?: string }> }
    expect(JSON.stringify(listed.content[0]?.text)).toContain('packages/memory')
  })

  it('ends the session on client close (DELETE drops the session id)', async () => {
    const { port } = await boot()
    const url = new URL(`http://127.0.0.1:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'http-probe-close', version: '1' })
    await client.connect(transport as unknown as Transport)
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    const sessionId = transport.sessionId
    expect(sessionId).toBeDefined()
    // The client half of a session close is HTTP DELETE (the SDK's
    // `terminateSession` hangs under the worker-thread test pool, so the
    // request goes out raw here). The server transport answers 200, fires
    // `onclose`, and the session pair leaves the routing table.
    console.log('STEP before delete')
    const del = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId as string } })
    console.log('STEP after delete', del.status)
    expect(del.status).toBe(200)
    const stale = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    // A stale or unknown session id must not mint a replacement session —
    // the streamable-http spec says the client re-initializes instead.
    expect(stale.status).toBe(404)
  })
})
