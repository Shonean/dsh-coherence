import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

// The plugin packages only: vendored build tooling (typert generator) is
// upstream code exercised by upstream suites, not by this repository's gate.
const testIncludes = [
  'packages/plugin/*/tests/**/*.spec.{ts,tsx}',
  'packages/client/*/tests/**/*.spec.{ts,tsx}',
]

const coverageIncludes = [
  'packages/plugin/*/src/**/*.{ts,tsx}',
  'packages/client/*/src/**/*.{ts,tsx}',
]

// Types-only files carry no executable code.
const coverageExcludes = [
  'packages/*/*/src/types.ts',
  'packages/*/*/src/bin.ts',
]

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    // The published rc.2 dsh client packages ship in the platform's module-loader
    // bundle format, which plain vitest/jsdom cannot execute. jsdom rendering is
    // verified against the real desktop frontend in B2 (CDP), so the bundle-dependent
    // render/registration specs are gated out here; the node-only client suites
    // (groups.client.spec.ts, invariant.client.spec.ts) still run.
    exclude: [
      ...configDefaults.exclude,
      'packages/client/ui-coherence/tests/subagent-row.client.spec.tsx',
      'packages/client/ui-coherence/tests/browser-plugin.client.spec.ts',
      'packages/client/ui-coherence-hub/tests/apply.client.spec.tsx',
      'packages/client/ui-coherence-hub/tests/hub-view.client.spec.tsx',
      'packages/client/ui-coherence-inventory/tests/browser-plugin.client.spec.tsx',
      'packages/client/ui-coherence-inventory/tests/components.client.spec.tsx',
    ],
    execArgv: vitestExecArgv,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: coverageIncludes,
      exclude: coverageExcludes,
      // 100% or it doesn't merge. Per-file so a well-covered big file can't
      // subsidize a bare one.
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: process.env.CI ? ['text', uncoveredLocationsReporter] : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
