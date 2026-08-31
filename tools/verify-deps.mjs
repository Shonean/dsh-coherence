// Verifies every @deepseek-ai/* dependency this repository consumes actually
// exists on npm, and reports which published versions match the pinned line.
// Run: node tools/verify-deps.mjs [--json]
// Exit 1 when any dependency is missing or lacks the required version line.

const REQUIRED_VERSION = '0.1.1-rc.2'

// Vendored framework forks follow their own upstream version lines; these are
// the exact versions the plugin was developed and tested against.
const VENDOR_FORK_PINS = {
  '@deepseek-ai/cosmokit': '1.8.2',
  '@deepseek-ai/schemastery': '3.18.1',
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-timer': '1.1.3',
  '@deepseek-ai/cordis-plugin-include': '1.0.6',
  '@deepseek-ai/cordis-plugin-loader': '1.0.2',
}

const DEPS = [
  // dsh kernel packages consumed at runtime
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-host-plugin-inventory',
  // dev/test support
  '@deepseek-ai/dsh-client-test-runtime',
  '@deepseek-ai/dsh-loader-smoke',
]

const json = process.argv.includes('--json')
const results = []
let failed = false

await Promise.all([...DEPS, ...Object.keys(VENDOR_FORK_PINS)].map(async (name) => {
  const required = VENDOR_FORK_PINS[name] ?? REQUIRED_VERSION
  const entry = { name, ok: false, latest: null, pinnedLine: null, versions: [] }
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
    if (response.status === 404) {
      entry.error = 'not on npm'
    } else if (!response.ok) {
      entry.error = `registry HTTP ${response.status}`
    } else {
      const data = await response.json()
      entry.latest = data['dist-tags']?.latest ?? null
      entry.versions = Object.keys(data.versions ?? {})
      entry.pinnedLine = entry.versions.includes(required) ? required : null
      entry.ok = entry.pinnedLine !== null
      if (!entry.ok) entry.error = `no ${required} published`
    }
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error)
  }
  if (!entry.ok) failed = true
  results.push(entry)
}))

results.sort((left, right) => left.name.localeCompare(right.name))
if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const entry of results) {
    const status = entry.ok ? 'OK  ' : 'FAIL'
    const version = entry.ok ? `pin ${entry.pinnedLine} (latest tag ${entry.latest})` : (entry.error ?? 'unknown error')
    console.log(`${status} ${entry.name} — ${version}`)
  }
  console.log(failed ? '\nRESULT: some dependencies are unusable from npm' : `\nRESULT: all ${results.length} dependencies available at ${REQUIRED_VERSION}`)
}
process.exit(failed ? 1 : 0)
