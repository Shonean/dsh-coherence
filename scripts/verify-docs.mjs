#!/usr/bin/env node
/**
 * dsh-coherence doc gates — lightweight bilingual-README and link audit for
 * this standalone repository. The heavy mdast-based pairing gate of the
 * monorepo is out of scope here; these checks cover what a published repo
 * must not ship broken:
 *
 *   1. README triads — every README.md has a sibling README.zh.md and
 *      README.i18n.yaml (and vice versa); no orphan sidecar.
 *   2. Internal links — every relative Markdown link in a README resolves
 *      to an existing file in this repo.
 *   3. Stale references — no monorepo leftovers: scoped self-names
 *      (`@deepseek-ai/dsh-*` for packages published from this repo) and
 *      moved paths (`packages/memory/coherence`, `packages/bundle/...`).
 *   4. Translation-pair records — the `README.i18n.yaml` git blob hashes
 *      match the current files (same algorithm as the monorepo pairing gate:
 *      `sha1("blob ${len}\0" + bytes)`).
 *   5. Root README parity — README.md and README.zh.md expose the same
 *      heading structure (same count, same levels, in order).
 *
 * Usage:
 *   node scripts/verify-docs.mjs           # verify only (exit 1 on failure)
 *   node scripts/verify-docs.mjs --write   # re-record i18n.yaml blob hashes
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRITE = process.argv.includes('--write')

let failures = 0
const fail = (msg) => {
  failures++
  console.error(`  ✗ ${msg}`)
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

/** Full git blob hash of exact file bytes (matches `git hash-object`). */
function blobHash(buf) {
  const hash = createHash('sha1')
  hash.update(`blob ${buf.byteLength}\0`)
  hash.update(buf)
  return hash.digest('hex')
}

/**
 * LF-normalized copy of a file's bytes. The repo forces `eol=lf` via
 * .gitattributes, so the committed blob is LF regardless of the checkout's
 * local line endings; hashing the normalized bytes keeps the records
 * identical between a Windows checkout and a Linux CI checkout.
 */
function lfBytes(file) {
  return Buffer.from(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/** Recursively list files under `dir`, skipping VCS and installed deps. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const ALL = walk(ROOT)

/* ------------------------------------------------------------------ *
 * 1. README triads
 * ------------------------------------------------------------------ */
console.log('README triads')
const readmes = ALL.filter((f) => {
  const base = basenameOf(f)
  return base === 'README.md' || base === 'README.zh.md' || base === 'README.i18n.yaml'
})
function basenameOf(p) {
  return p.split(/[\\/]/).at(-1)
}
const byDir = new Map()
for (const f of readmes) {
  const d = dirname(f)
  if (!byDir.has(d)) byDir.set(d, new Set())
  byDir.get(d).add(basenameOf(f))
}
for (const [dir, names] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
  const rel = relative(ROOT, dir) || '.'
  const md = names.has('README.md')
  const zh = names.has('README.zh.md')
  const meta = names.has('README.i18n.yaml')
  if (md && !zh) fail(`${rel}/README.md has no README.zh.md twin`)
  if (md && !meta) fail(`${rel}/README.md has no README.i18n.yaml record`)
  if (zh && !md) fail(`${rel}/README.zh.md has no README.md twin`)
  if (meta && !(md && zh)) fail(`${rel}/README.i18n.yaml lacks both README.md and README.zh.md twins`)
  if (md && zh && meta) ok(`${rel}: md + zh + i18n.yaml`)
}
if (byDir.size === 0) fail('no README files found at all')

/* ------------------------------------------------------------------ *
 * 2. Internal link resolution
 * ------------------------------------------------------------------ */
console.log('Internal links')
const LINK = /\[[^\]]*\]\(([^)]+)\)/g
for (const f of readmes.filter((x) => basenameOf(x) !== 'README.i18n.yaml')) {
  const text = readFileSync(f, 'utf8')
  const dir = dirname(f)
  for (const m of text.matchAll(LINK)) {
    let target = m[1].trim().split(/\s+/)[0]
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue
    target = target.split('#')[0]
    const resolved = resolve(dir, target)
    if (!existsSync(resolved)) {
      fail(`${relative(ROOT, f)} -> ${target} (missing ${relative(ROOT, resolved)})`)
    }
  }
}
ok('all internal relative links resolve')

/* ------------------------------------------------------------------ *
 * 3. Stale references (monorepo leftovers)
 * ------------------------------------------------------------------ */
console.log('Stale references')
const STALE = [
  /@deepseek-ai\/dsh-coherence\b/,
  /@deepseek-ai\/dsh-client-ui-coherence/,
  /\bmemory\/coherence\b/,
  /packages\/bundle\//,
  /packages\/memory\//,
]
const STALE_SCOPE_DIRS = [ROOT, join(ROOT, 'packages', 'client'), join(ROOT, 'packages', 'plugin'), join(ROOT, 'docs')]
const staleFiles = new Set()
for (const scope of STALE_SCOPE_DIRS) {
  if (!existsSync(scope)) continue
  for (const f of walk(scope)) {
    const ext = extname(f)
    if (ext !== '.md' && ext !== '.yml' && ext !== '.yaml') continue
    const text = readFileSync(f, 'utf8')
    for (const re of STALE) {
      const m = re.exec(text)
      if (m) {
        staleFiles.add(f)
        fail(`${relative(ROOT, f)}: stale reference \`${m[0]}\``)
      }
    }
  }
}
if (staleFiles.size === 0) ok('no stale scoped names or moved paths')

/* ------------------------------------------------------------------ *
 * 4. Translation-pair records (i18n.yaml blob hashes)
 * ------------------------------------------------------------------ */
console.log('Translation-pair records')
const PAIR_META = /^([^:#]+\.md): ([0-9a-f]{40})$/
for (const metaFile of readmes.filter((x) => basenameOf(x) === 'README.i18n.yaml')) {
  const text = readFileSync(metaFile, 'utf8')
  const recorded = new Map()
  let malformed = false
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    const m = PAIR_META.exec(line)
    if (!m) {
      malformed = true
      continue
    }
    if (recorded.has(m[1])) malformed = true
    recorded.set(m[1], m[2])
  }
  const dir = dirname(metaFile)
  const rel = relative(ROOT, metaFile)
  if (malformed || recorded.size !== 2 || !recorded.has('README.md') || !recorded.has('README.zh.md')) {
    fail(`${rel}: malformed record (expected exactly README.md + README.zh.md lines)`)
    continue
  }
  let dirty = false
  for (const [name, expected] of recorded) {
    const actual = blobHash(lfBytes(join(dir, name)))
    if (actual !== expected) {
      dirty = true
      if (WRITE) recorded.set(name, actual)
      else fail(`${rel}: ${name} hash changed (${expected} -> ${actual})${WRITE ? '' : '; run with --write to re-record'}`)
    }
  }
  if (dirty && WRITE) {
    const header = text.split('\n').filter((l) => l.startsWith('#')).join('\n')
    const body = [...recorded].map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(metaFile, `${header}\n${body}\n`)
    ok(`${rel}: re-recorded hashes`)
  } else if (dirty) {
    fail(`${rel}: translation-pair record is stale`)
  } else {
    ok(`${rel}: hashes match`)
  }
}

/* ------------------------------------------------------------------ *
 * 5. Root README heading-structure parity
 * ------------------------------------------------------------------ */
console.log('Root README parity')
function headingLevels(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => /^(#{1,6})\s+/.exec(l)?.[1].length)
    .filter((n) => n !== undefined)
}
const enLevels = headingLevels(join(ROOT, 'README.md'))
const zhLevels = headingLevels(join(ROOT, 'README.zh.md'))
if (JSON.stringify(enLevels) !== JSON.stringify(zhLevels)) {
  fail(`README.md heading levels ${JSON.stringify(enLevels)} != README.zh.md ${JSON.stringify(zhLevels)}`)
} else {
  ok(`heading structure aligned (${JSON.stringify(enLevels)})`)
}

/* ------------------------------------------------------------------ */
if (failures > 0) {
  console.error(`\ndoc gates failed: ${failures} issue(s)`)
  process.exit(1)
}
console.log('\ndoc gates passed')
