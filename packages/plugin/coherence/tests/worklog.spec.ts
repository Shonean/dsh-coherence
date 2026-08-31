// Worklog service behavior: direction lifecycle (one active, supersede on
// replace), work-log entries, and cross-agent handoffs.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorklogService } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount storage plus the worklog service over a temp JSON root. */
async function setup(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-worklog-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorklogService)
  return ctx
}

describe('worklog service', () => {
  it('creates a direction and returns it as active', async () => {
    const ctx = await setup()
    const id = await ctx.worklog.updateDirection({
      title: 'Build the plugin',
      objective: 'Ship dsh-coherence',
      constraints: ['one package'],
    })
    const direction = ctx.worklog.getActiveDirection()
    expect(direction?.directionId).toBe(id)
    expect(direction?.objective).toBe('Ship dsh-coherence')
    expect(direction?.status).toBe('active')
  })

  it('supersedes the previous active direction when a new one is created', async () => {
    const ctx = await setup()
    await ctx.worklog.updateDirection({ title: 'A', objective: 'first' })
    await ctx.worklog.updateDirection({ title: 'B', objective: 'second' })
    const direction = ctx.worklog.getActiveDirection()
    expect(direction?.title).toBe('B')
    const superseded = ctx.worklog.listDirections().filter(d => d.status === 'superseded')
    expect(superseded.length).toBe(1)
    expect(superseded[0]?.title).toBe('A')
  })

  it('appends and lists work-log entries newest first', async () => {
    const ctx = await setup()
    const directionId = await ctx.worklog.updateDirection({ title: 'A', objective: 'first' })
    await ctx.worklog.log({ text: 'milestone one', kind: 'milestone', directionId })
    await ctx.worklog.log({ text: 'decision made', kind: 'decision', directionId })
    const entries = ctx.worklog.listEntries({ directionId })
    expect(entries.length).toBe(2)
    expect(entries[0]?.text).toBe('decision made')
    expect(entries[1]?.text).toBe('milestone one')
  })

  it('records a handoff and a matching work-log entry', async () => {
    const ctx = await setup()
    const directionId = await ctx.worklog.updateDirection({ title: 'A', objective: 'first' })
    const handoffId = await ctx.worklog.handoff({
      from: 'main',
      to: 'opencode',
      summary: 'continue the ingest work',
      pendingItems: ['opencode db'],
      linkedDirectionId: directionId,
    })
    expect(handoffId).toBeDefined()
    const handoffEntry = ctx.worklog.listEntries({ kind: 'handoff' })[0]
    expect(handoffEntry?.text).toContain('main → opencode')
    expect(handoffEntry?.directionId).toBe(directionId)
  })
})
