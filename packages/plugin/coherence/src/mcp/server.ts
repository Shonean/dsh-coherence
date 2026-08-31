/**
 * MCP server bridge: exposes the suite's services (memory, codebase map,
 * worklog, transcript) to external agents as MCP tools over Streamable HTTP.
 * This is the "MCP bridge" of the design — workbuddy-era agents (claude code,
 * opencode, codex) each point their MCP client at this endpoint and read/write
 * the shared memory, direction, and codebase map through it.
 *
 * The server has no agent context, so it exposes only the fixed service-backed
 * tool set, never a passthrough of `ctx.tools`.
 * @module dsh-coherence/src/mcp/server
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { McpServerConfig } from '../config.ts'
import type { CodebaseMapFilter, CodebaseMapService } from '../service/codebase-map.ts'
import type { MemoryFilter, MemoryRecallQuery, MemoryService, MemoryWriteInput } from '../service/memory.ts'
import type { DirectionUpdate, WorklogEntryInput, WorklogService } from '../service/worklog.ts'
import type { TranscriptQuery, TranscriptService } from '../service/transcript.ts'

/** Services the bridge can surface; absent services skip their tools. */
export interface McpServices {
  memory?: MemoryService
  codebaseMap?: CodebaseMapService
  worklog?: WorklogService
  transcript?: TranscriptService
}

/** Text result block for an MCP tool call. */
function text(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

/** JSON text result. */
function json(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  // JSON.stringify collapses undefined to undefined; a raw pass-through would
  // emit a `text: undefined` content item that fails the SDK's own result
  // validation (observed as worklog_get_direction on a shard without a
  // direction). Serialize the absence loudly instead.
  const serialized = JSON.stringify(value)
  // JSON.stringify returns undefined at runtime for an undefined input despite
  // the static `string` return; serialize that absence loudly instead.
  return text(typeof serialized === 'string' ? serialized : 'null')
}

/** Register one tool unless the enabled-tools whitelist excludes it. */
function tool(
  mcp: McpServer,
  enabled: ReadonlySet<string>,
  name: string,
  description: string,
  schema: z.ZodType,
  handler: (args: Record<string, unknown>) => unknown,
): void {
  if (enabled.size > 0 && !enabled.has(name)) return
  mcp.registerTool(
    name,
    { description, inputSchema: schema },
    async (args: unknown) => json(await handler(args as Record<string, unknown>)),
  )
}

const memoryLayer = z.enum(['working', 'episodic', 'semantic'])

/**
 * Register the fixed service-backed tool set.
 * @param mcp - the MCP server.
 * @param services - available suite services.
 * @param enabled - enabled-tools whitelist (empty = all).
 */
export function registerTools(mcp: McpServer, services: McpServices, enabled: ReadonlySet<string>): void {
  if (services.memory !== undefined) {
    const memory = services.memory
    tool(mcp, enabled, 'memory_write', 'Write one entry to a memory layer.', z.object({
      layer: memoryLayer,
      content: z.string(),
      subject: z.string().optional(),
      importance: z.number().optional(),
      tags: z.array(z.string()).optional(),
    }), (args) => {
      const input: MemoryWriteInput = { layer: args.layer as 'working' | 'episodic' | 'semantic', content: args.content as string }
      if (args.subject !== undefined) input.subject = args.subject as string
      if (args.importance !== undefined) input.importance = args.importance as number
      if (args.tags !== undefined) input.tags = args.tags as string[]
      return memory.write(input)
    })
    tool(mcp, enabled, 'memory_recall', 'Recall the most relevant stored memory.', z.object({
      query: z.string().optional(),
      maxTokens: z.number().optional(),
      layers: z.array(memoryLayer).optional(),
    }), (args) => {
      const query: MemoryRecallQuery = {}
      if (args.query !== undefined) query.query = args.query as string
      if (args.maxTokens !== undefined) query.maxTokens = args.maxTokens as number
      if (args.layers !== undefined) query.layers = args.layers as Array<'working' | 'episodic' | 'semantic'>
      return memory.recall(query)
    })
    tool(mcp, enabled, 'memory_list', 'List stored memory entries.', z.object({
      layer: memoryLayer.optional(),
      state: z.enum(['active', 'outdated', 'contradicted', 'tentative']).optional(),
    }), (args) => {
      const filter: MemoryFilter = {}
      if (args.layer !== undefined) filter.layer = args.layer as 'working' | 'episodic' | 'semantic'
      if (args.state !== undefined) filter.state = args.state as 'active' | 'outdated' | 'contradicted' | 'tentative'
      return memory.list(filter)
    })
    tool(mcp, enabled, 'memory_status', 'Report per-layer memory counts.', z.object({}), () => memory.stats())
  }

  if (services.codebaseMap !== undefined) {
    const codebaseMap = services.codebaseMap
    tool(mcp, enabled, 'codebase_map_get', 'Fetch one codebase-map node by address.', z.object({
      kind: z.enum(['folder', 'file', 'symbol']),
      address: z.string(),
    }), args => codebaseMap.get(args.address as string, args.kind as 'folder' | 'file' | 'symbol'))
    tool(mcp, enabled, 'codebase_map_list', 'List codebase-map nodes.', z.object({
      kind: z.enum(['folders', 'files', 'symbols']).optional(),
    }), (args) => {
      const kind = args.kind as 'folders' | 'files' | 'symbols' | undefined
      const filter: CodebaseMapFilter = kind === undefined ? {} : { kind }
      return codebaseMap.list(filter)
    })
    tool(mcp, enabled, 'codebase_map_save', 'Store one codebase-map node.', z.object({
      kind: z.enum(['folder', 'file', 'symbol']),
      relativePath: z.string().optional(),
      qualifiedName: z.string().optional(),
      summary: z.string(),
    }), async (args) => {
      if (args.kind === 'symbol') {
        await codebaseMap.upsert({
          qualifiedName: args.qualifiedName as string,
          kind: 'function',
          file: '',
          docSummary: args.summary as string,
        })
      } else {
        const relativePath = args.relativePath as string
        if (args.kind === 'folder') {
          await codebaseMap.upsert({
            relativePath,
            name: relativePath.split('/').at(-1) ?? relativePath,
            purpose: '',
            keyFiles: [],
            summary: args.summary as string,
            exploredAt: Date.now(),
          })
        } else {
          await codebaseMap.upsert({
            relativePath,
            kind: 'source',
            summary: args.summary as string,
            keySymbols: [],
            responsibilities: [],
            exploredAt: Date.now(),
          })
        }
      }
      return { stored: true }
    })
  }

  if (services.worklog !== undefined) {
    const worklog = services.worklog
    // The bridge has no agent session, so it scopes every worklog call to the
    // kernel's own workspace: the child process cwd (the desktop host passes
    // the workspace folder both as cwd and DSH_CWD). Omission would silently
    // target the legacy shard instead of the user's workspace.
    const workspaceId = (): Promise<string | undefined> =>
      worklog.resolveWorkspaceId(process.env.DSH_CWD ?? process.cwd())
    tool(mcp, enabled, 'worklog_get_direction', 'Return the current shared work direction.', z.object({}),
      async () => worklog.getActiveDirection(await workspaceId()))
    tool(mcp, enabled, 'worklog_update_direction', 'Set the shared work direction.', z.object({
      title: z.string(),
      objective: z.string(),
      directionId: z.string().optional(),
      scope: z.string().optional(),
      constraints: z.array(z.string()).optional(),
    }), async (args) => {
      const update: DirectionUpdate = { title: args.title as string, objective: args.objective as string }
      if (args.directionId !== undefined) update.directionId = args.directionId as string
      if (args.scope !== undefined) update.scope = args.scope as string
      if (args.constraints !== undefined) update.constraints = args.constraints as string[]
      return worklog.updateDirection(update, await workspaceId())
    })
    tool(mcp, enabled, 'worklog_log', 'Append one shared work-log entry.', z.object({
      text: z.string(),
      kind: z.enum(['log', 'milestone', 'decision', 'handoff', 'explore']).optional(),
      directionId: z.string().optional(),
    }), async (args) => {
      const entry: WorklogEntryInput = { text: args.text as string }
      if (args.kind !== undefined) entry.kind = args.kind as 'log' | 'milestone' | 'decision' | 'handoff' | 'explore'
      if (args.directionId !== undefined) entry.directionId = args.directionId as string
      return worklog.log(entry, await workspaceId())
    })
    tool(mcp, enabled, 'worklog_list', 'List recent shared work-log entries.', z.object({
      kind: z.enum(['log', 'milestone', 'decision', 'handoff', 'explore']).optional(),
      limit: z.number().optional(),
    }), async (args) => {
      const kind = args.kind as 'log' | 'milestone' | 'decision' | 'handoff' | 'explore' | undefined
      return worklog.listEntries(kind === undefined ? {} : { kind }, await workspaceId())
        .slice(0, args.limit as number | undefined ?? 50)
    })
  }

  if (services.transcript !== undefined) {
    const transcript = services.transcript
    tool(mcp, enabled, 'transcript_search', 'Search normalized external-agent transcripts.', z.object({
      query: z.string().optional(),
      agentType: z.enum(['main', 'claude-code', 'opencode', 'codex']).optional(),
      sessionId: z.string().optional(),
      limit: z.number().optional(),
    }), (args) => {
      const query: TranscriptQuery = {}
      if (args.query !== undefined) query.query = args.query as string
      if (args.agentType !== undefined) query.agentType = args.agentType as 'main' | 'claude-code' | 'opencode' | 'codex'
      if (args.sessionId !== undefined) query.sessionId = args.sessionId as string
      if (args.limit !== undefined) query.limit = args.limit as number
      return transcript.query(query)
    })
  }
}

/** Handle to a mounted MCP server. */
export interface McpServerMount {
  /** Effective listening port (differs from config when port 0 picked a free one). */
  readonly port: number
  /** Stop listening and close every per-session transport. Idempotent. */
  close(): void
}

/**
 * Mount the in-process MCP server on `127.0.0.1:<port><path>`. Resolves once
 * the socket is listening; a bind failure rejects so the plugin mount fails
 * loud instead of silently leaving the endpoint down.
 * @param ctx - plugin context carrying the suite services.
 * @param config - MCP-server settings.
 * @returns the mounted handle once listening.
 */
export async function mountMcpServer(ctx: Context, config: McpServerConfig): Promise<McpServerMount> {
  const enabled = new Set(config.enabledTools)
  const services: McpServices = {}
  const memory = ctx.get('memory')
  const codebaseMap = ctx.get('codebaseMap')
  const worklog = ctx.get('worklog')
  const transcript = ctx.get('transcript')
  if (memory !== undefined) services.memory = memory
  if (codebaseMap !== undefined) services.codebaseMap = codebaseMap
  if (worklog !== undefined) services.worklog = worklog
  if (transcript !== undefined) services.transcript = transcript
  // One (McpServer, transport) pair per MCP session: the SDK's streamable-http
  // transport holds a single session's state (`_initialized` + `sessionId`)
  // and a McpServer connects to exactly one transport, so reusing either for
  // every request would lock the endpoint to one client forever (a second
  // initialize reports "already initialized" — and an unconnected transport
  // never answers, so the client hangs). Route each request to its session's
  // pair by the `Mcp-Session-Id` header, creating the pair on a fresh session
  // and registering it once the SDK assigns the id.
  interface SessionPair {
    transport: StreamableHTTPServerTransport
    mcp: McpServer
    /** The SDK-assigned session id, set once `initialize` completes. */
    sessionId?: string
  }
  const sessions = new Map<string, SessionPair>()
  const logger = ctx.logger('dsh-coherence')

  /** Build one server/transport pair for a fresh session and wire them. */
  const createSession = (): SessionPair => {
    const mcp = new McpServer(
      { name: 'dsh-coherence', version: '0.1.0' },
      { capabilities: { tools: {} } },
    )
    registerTools(mcp, services, enabled)
    const pair: SessionPair = {
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Direct JSON responses: a local loopback bridge needs neither
        // server-pushed SSE nor long-lived GET streams, and clients without
        // SSE support (or without a concurrent GET) never hang on a response
        // that was meant to arrive over a stream.
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          pair.sessionId = id
          sessions.set(id, pair)
        },
      }),
      mcp,
    }
    // The SDK's transport constructor ignores an `onclose` option (only
    // `onsessioninitialized`/`onsessionclosed` are read there), so register
    // the cleanup on the instance: `close()` fires it at both ends of a
    // session — an HTTP DELETE from the client and an explicit
    // `transport.close()` — and the ended session leaves the routing table
    // instead of accumulating over the host process's lifetime.
    pair.transport.onclose = () => {
      if (pair.sessionId !== undefined) sessions.delete(pair.sessionId)
    }
    // The SDK transport declares explicit optional callbacks
    // (`onclose: (() => void) | undefined`), which exactOptionalPropertyTypes
    // rejects at the Transport boundary.
    void mcp.connect(pair.transport as unknown as Transport).catch((error: unknown) => {
      logger.warn(`mcp session connect failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return pair
  }

  const server = http.createServer((req, res) => {
    if (req.url !== config.path) {
      res.writeHead(404).end()
      return
    }
    const header = req.headers['mcp-session-id']
    const sessionId = typeof header === 'string' ? header : undefined
    const pair = sessionId !== undefined ? sessions.get(sessionId) : undefined
    if (sessionId !== undefined && pair === undefined) {
      // Unknown or already-ended session id: the streamable-http spec says the
      // client must re-initialize, so reject instead of minting a replacement.
      res.writeHead(404).end()
      return
    }
    const { transport } = pair ?? createSession()
    // The SDK reads the request body itself (its Node listener converts the
    // raw stream to a Web Request); draining it here would make the listener
    // wait on a stream that already ended.
    void transport.handleRequest(req, res).catch((error: unknown) => {
      logger.warn(`mcp request failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  server.on('error', (error: Error & { code?: string }) => {
    // EADDRINUSE (and friends) arrive before/around listen(); awaiting the
    // 'listening' race below rejects the mount, later runtime errors just log.
    logger.warn(`mcp server error on ${config.port}: ${error.message}`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1')
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const close = (): void => {
    for (const { transport, mcp } of sessions.values()) {
      void transport.close()
      void mcp.close()
    }
    server.close()
  }
  ctx.effect(() => close, 'coherence.mcpServerClose')
  return { port, close }
}
