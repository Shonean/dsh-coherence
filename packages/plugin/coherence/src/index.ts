/**
 * The dsh-coherence plugin: one Cordis plugin that unifies external-agent transcripts,
 * three-layer memory, the codebase map, the shared worklog, and an MCP bridge
 * for the external agents (claude code, opencode, codex) to reach them.
 *
 * Every subsystem is an internal module mounted from `apply` behind a
 * `Config.features` flag; each service opens and closes its own storage domain
 * with the plugin, and each ingest poll is a lifecycle-managed timer.
 * @module dsh-coherence
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the timer service's `ctx.interval` augmentation into this
// program without a runtime import (the suite injects the timer service).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { Config } from './config.ts'
import { mountClaudeIngest } from './ingest/claude.ts'
import { mountCodexIngest } from './ingest/codex.ts'
import { mountOpencodeIngest } from './ingest/opencode.ts'
import type { IngestHandle } from './ingest/handle.ts'
import { mountWorkspaceSync } from './ingest/workspace-sync.ts'
import { mountMcpServer } from './mcp/server.ts'
import { mountMirror } from './mirror.ts'
import { runConsolidation } from './service/consolidation.ts'
import type { DistillOptions } from './service/distill.ts'
import { CoherenceRemoteGateway } from './remote.ts'
import { CodebaseMapService } from './service/codebase-map.ts'
import { MemoryService } from './service/memory.ts'
import { TranscriptService } from './service/transcript.ts'
import { WorklogService } from './service/worklog.ts'
import * as ToolCodebaseMap from './tool/codebase-map.ts'
import * as ToolMemory from './tool/memory.ts'
import * as ToolWorklog from './tool/worklog.ts'
import { mountDirectionSection, mountSubagentLogging } from './worklog-integration.ts'

export { Config } from './config.ts'
export * from './domain/index.ts'
export * from './service/transcript.ts'
export * from './service/memory.ts'
export * from './service/codebase-map.ts'
export * from './service/worklog.ts'
export * from './tool/memory.ts'
export * from './tool/codebase-map.ts'
export * from './tool/worklog.ts'
export * from './ingest/claude.ts'
export * from './ingest/handle.ts'
export * from './ingest/opencode.ts'
export * from './ingest/codex.ts'
export * from './ingest/workspace-sync.ts'
export * from './mcp/server.ts'
export * from './mirror.ts'
export * from './service/consolidation.ts'
export * from './service/distill.ts'
export * from './remote.ts'
export * from './worklog-integration.ts'
export * from './session-events.ts'
export * from './workspace-shards.ts'
export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-coherence'
/** The storage hub (with its domain form) and the timer service must be present. */
export const inject = ['storageDomain', 'timer']

/** Connector distillation options from the parsed ingest config; `undefined` disables. */
function distillOptions(config: Config): DistillOptions | undefined {
  return config.ingest.distillSessions ? { minMessages: config.ingest.distillMinMessages } : undefined
}

/**
 * Mount the suite. Each enabled subsystem opens its domain via its service;
 * ingest connectors start lifecycle-managed polls; a reload unwinds every
 * registration in reverse order.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 * @returns resolution after every enabled subsystem mounts.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.features.transcript) {
    await ctx.plugin(TranscriptService, { redactCredentials: config.ingest.redactCredentials })
  }
  if (config.features.memory) {
    await ctx.plugin(MemoryService, {
      budget: config.memory.budget,
      recallMaxTokens: config.memory.recallMaxTokens,
    })
    // Tools mount only when the tool registry is composed (every web profile
    // has it); without it the suite's services still work.
    ctx.inject(['tools'], async (toolCtx) => {
      await toolCtx.plugin(ToolMemory)
    })
  }
  if (config.features.codebaseMap) {
    await ctx.plugin(CodebaseMapService)
    ctx.inject(['tools'], async (toolCtx) => {
      await toolCtx.plugin(ToolCodebaseMap)
    })
  }
  if (config.features.worklog) {
    await ctx.plugin(WorklogService)
    const worklog = ctx.get('worklog') as WorklogService
    // Inject the active direction into the main agent's prompt when the
    // system-prompt service is composed.
    ctx.inject(['systemPrompt'], (promptCtx) => {
      mountDirectionSection(promptCtx, worklog)
    })
    mountSubagentLogging(ctx, worklog)
    ctx.inject(['tools'], async (toolCtx) => {
      await toolCtx.plugin(ToolWorklog)
    })
  }
  const ingestHandles: IngestHandle[] = []
  if (config.features.ingestClaude && config.features.transcript) {
    // The property proxy would require an `inject` the suite cannot declare
    // (it mounts the service itself); `ctx.get` reads the global service store.
    // Exploration capture into the codebase map is gated on that feature and
    // its `autoCaptureExplore` switch (both default on).
    const codebaseMap = config.features.codebaseMap && config.codebaseMap.autoCaptureExplore
      ? ctx.get('codebaseMap') as CodebaseMapService
      : undefined
    ingestHandles.push(mountClaudeIngest(
      ctx,
      ctx.get('transcript') as TranscriptService,
      config.ingest.claude,
      codebaseMap,
      distillOptions(config),
    ))
  }
  if (config.features.ingestOpencode && config.features.transcript) {
    ingestHandles.push(mountOpencodeIngest(
      ctx,
      ctx.get('transcript') as TranscriptService,
      config.ingest.opencode,
      distillOptions(config),
    ))
  }
  if (config.features.ingestCodex && config.features.transcript) {
    ingestHandles.push(mountCodexIngest(
      ctx,
      ctx.get('transcript') as TranscriptService,
      config.ingest.codex,
      distillOptions(config),
    ))
  }
  if (ingestHandles.length > 0) {
    mountWorkspaceSync(ctx, ingestHandles)
  }
  if (config.features.mcpServer) {
    await mountMcpServer(ctx, config.mcpServer)
  }
  if (config.features.webGateway) {
    await ctx.plugin(CoherenceRemoteGateway)
  }
  if (config.features.consolidation && config.features.memory) {
    const memory = ctx.get('memory') as MemoryService
    const poll = (): void => {
      if (memory.stats().episodic >= config.memory.consolidationEpisodicThreshold) {
        void runConsolidation(ctx, memory)
      }
    }
    poll()
    ctx.interval(poll, config.memory.consolidationIntervalMs)
  }
  if (config.features.mirror) {
    mountMirror(ctx, config.mirror)
  }
}
