// codex thread-metadata normalization and incremental read against a fixture DB.
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexIncremental, stateDbPath } from '../src/index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a fixture codex `state_5.sqlite` with one thread plus goals/memories. */
async function fixtureHome(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-codex-'))
  const db = new DatabaseSync(stateDbPath(root))
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT, cwd TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT);
    CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT);
  `)
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
    .run('t1', 'codex task', 'fix the ingest', '/repo', 1000, 1000)
  db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?)').run('t1', 'make ingest work', 'in_progress')
  db.prepare('INSERT INTO stage1_outputs VALUES (?, ?)').run('t1', 'opencode db path resolved')
  db.close()
  return root
}

describe('codex ingest', () => {
  it('ingests thread metadata as a session with the first user message', async () => {
    const home = await fixtureHome()
    const { batches } = readCodexIncremental(home, undefined, false)
    expect(batches.length).toBe(1)
    const batch = batches[0]
    expect(batch?.agentType).toBe('codex')
    expect(batch?.sessionId).toBe('t1')
    expect(batch?.meta?.title).toBe('codex task')
    expect(batch?.meta?.projectDir).toBe('/repo')
    expect(batch?.messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'fix the ingest' })
  })

  it('collects goals and memories when importMemories is set', async () => {
    const home = await fixtureHome()
    const { worklogLines, memoryContents } = readCodexIncremental(home, undefined, true)
    expect(worklogLines.some(line => line.includes('make ingest work'))).toBe(true)
    expect(memoryContents.some(content => content.includes('opencode db path'))).toBe(true)
  })

  it('skips already-seen threads by the updated-at watermark', async () => {
    const home = await fixtureHome()
    const first = readCodexIncremental(home, undefined, false)
    const second = readCodexIncremental(home, first.next, false)
    expect(second.batches.length).toBe(0)
  })
})
