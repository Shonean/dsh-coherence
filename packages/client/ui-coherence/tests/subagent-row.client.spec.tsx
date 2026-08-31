// @vitest-environment jsdom
// Dedicated subagent tool row: replay-stable task label, lifecycle states,
// background badge, prompt/result disclosure, keyboard operation, and the
// trajectory Inspect handoff.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SubagentRow } from '../src/client/SubagentRow.tsx'
import { zh } from '../src/client/locales.ts'

type SubagentRowProps = Parameters<typeof SubagentRow>[0]

// The published locale package ships lib/ only (no src/), so the shared common
// vocabulary is not reachable; the row only resolves its own row.* keys, so
// the namespace dictionary alone satisfies the stub.
const t: SubagentRowProps['t'] = makeTranslate(zh)

afterEach(cleanup)

const args = (over: Record<string, unknown> = {}): string => JSON.stringify({
  description: 'Fix the flaky MCP test',
  prompt: 'Investigate the streamable-http transport and make the second initialize succeed.',
  ...over,
})

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-subagent',
    call: { name: 'subagent', argsRaw: args() },
    callTime: 2_000,
    content: [{ type: 'text', text: 'Done: per-session transport map landed.' }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
    ...over,
  }
}

function running(argsRaw = args()): RunningToolCall {
  return {
    callId: 'call-subagent', name: 'subagent', argsRaw, turn: 1, step: 1, time: 2_000, callView: null, subCalls: [],
  }
}

function props(block: SubagentRowProps['block'], inspect?: () => void): SubagentRowProps {
  return {
    callId: block.callId,
    toolName: 'subagent',
    block,
    openFile: vi.fn(),
    inspect,
    t,
  } as unknown as SubagentRowProps
}

describe('SubagentRow', () => {
  it('renders the task label and discloses prompt and result', () => {
    const inspect = vi.fn()
    const view = render(<SubagentRow {...props(settled(), inspect)} />)
    const row = screen.getByRole('button', { name: '子 agentFix the flaky MCP test' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-tool="subagent"]')?.getAttribute('data-state')).toBe('ok')
    expect(screen.queryByLabelText('委派提示词')).toBeNull()

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const prompt = screen.getByLabelText('委派提示词')
    expect(prompt.textContent).toContain('second initialize succeed')
    const result = screen.getByLabelText('结果')
    expect(result.textContent).toContain('per-session transport map landed')
    expect(view.container.textContent).not.toContain('"description"')
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(inspect).toHaveBeenCalledTimes(1)

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('supports Enter and Space while ignoring unrelated keys', () => {
    render(<SubagentRow {...props(settled())} />)
    const row = screen.getByRole('button')
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a running call compact, announces its state, and already discloses the prompt', () => {
    const view = render(<SubagentRow {...props(running())} />)
    const row = view.container.querySelector('[data-tool="subagent"] > div')!
    // The delegation prompt is fully in the args while running, so the row is
    // expandable to show it — but no result card exists yet.
    expect(row.getAttribute('role')).toBe('button')
    expect(view.container.textContent).toContain('子 agent 运行中')
    expect(view.container.textContent).toContain('Fix the flaky MCP test')
    fireEvent.click(row)
    expect(screen.getByLabelText('委派提示词').textContent).toContain('second initialize succeed')
    expect(view.container.querySelector('[aria-label="结果"]')).toBeNull()
  })

  it('shows the background badge for a flagged call and for a continuable result', () => {
    const flagged = render(<SubagentRow {...props(running(args({ run_in_background: true })))} />)
    expect(flagged.container.textContent).toContain('后台')
    cleanup()

    const continuable = render(<SubagentRow {...props(settled({
      call: { name: 'subagent', argsRaw: args({ run_in_background: true }) },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'continuable', subagentId: 'sa_42' }) }],
    }))} />)
    expect(continuable.container.textContent).toContain('后台')
    cleanup()

    const foreground = render(<SubagentRow {...props(settled())} />)
    expect(foreground.container.textContent).not.toContain('后台')
  })

  it('uses the first failure line in the summary and exposes the full error', () => {
    const view = render(<SubagentRow {...props(settled({
      content: [{ type: 'text', text: 'SubagentError: provider unavailable\nRetry later.' }],
      isError: true,
      error: { name: 'SubagentError', code: 'provider-unavailable' },
    }))} />)
    const row = screen.getByRole('button', { name: '子 agent 失败子 agentSubagentError: provider unavailable' })
    expect(view.container.querySelector('[data-tool="subagent"]')?.getAttribute('data-state')).toBe('error')
    expect(row.textContent).not.toContain('Retry later.')
    fireEvent.click(row)
    const output = view.container.querySelector('[data-error="true"]')!
    expect(output.textContent).toContain('Retry later.')
  })

  it('renders the stopped state for an interrupted call', () => {
    const view = render(<SubagentRow {...props(settled({
      error: { name: 'InterruptedError', code: 'interrupted' },
    }))} />)
    expect(view.container.textContent).toContain('子 agent 已中止')
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('falls back to durable args or call id when the label is unavailable', () => {
    const invalid = render(<SubagentRow {...props(running('{"description":\n'))} />)
    expect(invalid.container.textContent).toContain('{"description":')
    cleanup()

    const blank = render(<SubagentRow {...props(settled({ call: null, content: [] }))} />)
    expect(blank.container.textContent).toContain('call-subagent')
    expect(blank.container.querySelector('[role="button"]')).toBeNull()
    expect(blank.container.textContent).not.toContain('子 agent 运行中')
  })
})
