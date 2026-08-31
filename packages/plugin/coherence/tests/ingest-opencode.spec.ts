// opencode transcript normalization and incremental read against a fixture DB.
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeOpencodePart, readOpencodeIncremental } from '../src/index.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a fixture opencode.db with one session of two messages. */
async function fixtureDb(withDirectoryColumn: boolean = false): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-coherence-opencode-'))
  const path = join(root, 'opencode.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER${withDirectoryColumn ? ', directory TEXT' : ''});
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `)
  if (withDirectoryColumn) {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('ses_1', 'fixture session', 1000, '/repo/app')
  } else {
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_1', 'fixture session', 1000)
  }
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_1', 'ses_1', 1000, JSON.stringify({
    role: 'user', time: { created: 1000 },
  }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_1', 'msg_1', JSON.stringify({ type: 'text', text: 'hello opencode' }))
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_2', 'ses_1', 2000, JSON.stringify({
    role: 'assistant', time: { created: 2000 },
  }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_2', 'msg_2', JSON.stringify({ type: 'reasoning', text: 'let me think' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_3', 'msg_2', JSON.stringify({ type: 'tool', tool: 'bash', input: 'ls' }))
  db.close()
  return path
}

describe('opencode ingest', () => {
  it('normalizes text, reasoning, and tool parts', () => {
    expect(normalizeOpencodePart({ type: 'text', text: 'x' })).toEqual({ kind: 'text', text: 'x' })
    expect(normalizeOpencodePart({ type: 'reasoning', text: 'y' })).toEqual({ kind: 'reasoning', text: 'y' })
    expect(normalizeOpencodePart({ type: 'tool', tool: 'bash', input: 'ls' })?.kind).toBe('tool_call')
    expect(normalizeOpencodePart({ type: 'step-start' })).toBeNull()
  })

  it('reads messages into one batch and advances the cursor', async () => {
    const path = await fixtureDb()
    const first = readOpencodeIncremental(path, undefined)
    expect(first.batches.length).toBe(1)
    const batch = first.batches[0]
    expect(batch?.agentType).toBe('opencode')
    expect(batch?.sessionId).toBe('ses_1')
    expect(batch?.meta?.title).toBe('fixture session')
    expect(batch?.messages.length).toBe(2)
    expect(batch?.messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'hello opencode' })
    expect(batch?.messages[1]?.parts.length).toBe(2)
    expect(first.next.lastRowId).toBeGreaterThan(0)

    // No new rows → empty batch, cursor unchanged.
    const second = readOpencodeIncremental(path, first.next)
    expect(second.batches.length).toBe(0)
  })

  it('carries the session directory as projectDir when the column exists', async () => {
    const path = await fixtureDb(true)
    const first = readOpencodeIncremental(path, undefined)
    expect(first.batches[0]?.meta?.projectDir).toBe('/repo/app')
  })

  it('skips the directory probe when the session table has no such column', async () => {
    const path = await fixtureDb(false)
    const first = readOpencodeIncremental(path, undefined)
    expect(first.batches[0]?.meta?.projectDir).toBeUndefined()
    expect(first.batches[0]?.meta?.title).toBe('fixture session')
  })
})
