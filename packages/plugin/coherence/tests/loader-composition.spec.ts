// Boots the real Loader over a cordis.yml carrying storage + the dsh-coherence plugin,
// proving the plugin composes with a real backend and that its four owned
// domains open for the enabled feature set. Mirrors the tool-todo loader test.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as MemorySuite from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml mounting storage over a temp JSON root plus the memory
 * suite with the given feature-toggle lines.
 * @param featureLines - YAML lines nested under `config.features`.
 * @returns the booted context with every entry activated.
 */
async function boot(featureLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-'))
  const storages = join(root, 'storages')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/cordis-plugin-timer'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(storages)}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: 'dsh-coherence'",
    '  config:',
    '    features:',
    ...featureLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/cordis-plugin-timer', Timer],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['dsh-coherence', MemorySuite],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** The four domains the suite owns, keyed by their domain name. */
const DOMAINS = ['transcript', 'memory', 'codebase_map', 'worklog'] as const

describe('dsh-coherence real Loader composition', () => {
  it('opens the four owned domains with the default feature set', async () => {
    const ctx = await boot([])
    const form = ctx.storage.form('domain')
    for (const name of DOMAINS) {
      expect(form.get(name), `domain '${name}' should be open`).toBeDefined()
    }
  }, 30_000)

  it('opens no domain when every feature is disabled', async () => {
    const ctx = await boot([
      '      transcript: false',
      '      memory: false',
      '      codebaseMap: false',
      '      worklog: false',
    ])
    const form = ctx.storage.form('domain')
    for (const name of DOMAINS) {
      expect(form.get(name), `domain '${name}' should stay closed`).toBeUndefined()
    }
  }, 30_000)

  it('opens only the transcript domain when only transcript is enabled', async () => {
    const ctx = await boot([
      '      transcript: true',
      '      memory: false',
      '      codebaseMap: false',
      '      worklog: false',
    ])
    const form = ctx.storage.form('domain')
    expect(form.get('transcript')).toBeDefined()
    for (const name of ['memory', 'codebase_map', 'worklog']) {
      expect(form.get(name), `domain '${name}' should stay closed`).toBeUndefined()
    }
  }, 30_000)

  it('parses an empty config to the full default feature set', () => {
    const parsed = MemorySuite.Config({} as MemorySuite.Config) as unknown as {
      features: Record<string, boolean>
      memory: { recallMaxTokens: number }
      ingest: { claude: { pollMs: number } }
    }
    expect(parsed.features.transcript).toBe(true)
    expect(parsed.features.mcpServer).toBe(false)
    expect(parsed.features.ingestClaude).toBe(true)
    // Every external connector is on by default; a source whose store is
    // absent warns once and stays idle (warn-once in the connector).
    expect(parsed.features.ingestOpencode).toBe(true)
    expect(parsed.features.ingestCodex).toBe(true)
    expect(parsed.memory.recallMaxTokens).toBe(4096)
    expect(parsed.ingest.claude.pollMs).toBe(60_000)
  })
})
