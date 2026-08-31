// Config defaults: a bare config activates every ingest connector (the sources
// absent on a machine warn once and stay idle) and the distillation gate.
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

// The runtime schema is cast to `z<Config>` at the type level, so the callable
// schema is invoked through an `unknown` input here.
const parseConfig = Config as unknown as (input: unknown) => {
  features: Record<string, boolean>
  ingest: Record<string, unknown>
}

describe('coherence config defaults', () => {
  it('enables every ingest connector and distillation on an empty config', () => {
    const parsed = parseConfig({})
    expect(parsed.features.ingestClaude).toBe(true)
    expect(parsed.features.ingestOpencode).toBe(true)
    expect(parsed.features.ingestCodex).toBe(true)
    expect(parsed.ingest.distillSessions).toBe(true)
    expect(parsed.ingest.distillMinMessages).toBe(4)
  })

  it('honors explicit opt-outs', () => {
    const parsed = parseConfig({
      features: { ingestOpencode: false },
      ingest: { distillSessions: false },
    })
    expect(parsed.features.ingestOpencode).toBe(false)
    expect(parsed.ingest.distillSessions).toBe(false)
  })
})
