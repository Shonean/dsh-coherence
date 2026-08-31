// Subagent toolview registrant: a domain-owned row over the keyed toolview
// hole. The compact row presents the model-authored 3-5 word task label and a
// background badge; the bounded disclosure shows the exact delegation prompt
// and the durable result. Replay-stable: every field derives from the frozen
// call/result slice, never from the live subagent catalog.

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconAgentPresetOutline16, IconChevronDownOutline14, IconInspectOutline12, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SubagentRow.module.css'

/** Subagent row lifecycle derived solely from the durable call slice. */
type SubagentRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Full row props: the toolview runtime share plus this package's locale seat. */
type SubagentRowProps = ToolCallViewProps & PropsLocale<'coherence'>

/** Compact, replay-stable view model for the dedicated row. */
interface SubagentRowModel {
  /** The model-authored task label (args.description). */
  label: string
  /** The delegation prompt (args.prompt), shown in the disclosure. */
  prompt: string | null
  /** Flattened durable result text. */
  output: string | null
  /** Whether the delegation runs detached (args.flag or a background/continuable result). */
  background: boolean
  readonly errorSummary: string | null
  readonly state: SubagentRowState
}

/** First physical line for the collapsed error summary and malformed-args fallback. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Parse the subagent call arguments, tolerant of streaming-truncated JSON. */
function parseArgs(argsRaw: string): { label: string | null; prompt: string | null; background: boolean } {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const label = typeof record.description === 'string' && record.description !== ''
        ? firstLine(record.description)
        : null
      const prompt = typeof record.prompt === 'string' && record.prompt !== '' ? record.prompt : null
      const background = record.run_in_background === true
      return { label, prompt, background }
    }
  } catch {
    // Streaming can expose a truncated JSON prefix; the caller falls back to
    // the raw args text rather than replacing the call with a catalog lookup.
  }
  return { label: null, prompt: null, background: false }
}

/** Flatten durable result blocks under the generic Tool-row text contract.
 *  Keep aligned with ui-tool's models/tool-call-model.ts `resultText`. */
function resultText(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** A background/continuable delegation returns its id as a structured JSON text. */
function resultIsBackground(output: string | null): boolean {
  if (output === null) return false
  try {
    const parsed = JSON.parse(output) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const kind = (parsed as Record<string, unknown>).kind
      return kind === 'background' || kind === 'continuable'
    }
  } catch {
    // Plain foreground result text: not a detachment marker.
  }
  return false
}

/** Derive the display state without consulting the live subagent catalog. */
function subagentRowModel(block: ToolCallViewProps['block']): SubagentRowModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: SubagentRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = resultText(block)
  const args = parseArgs(argsRaw)
  return {
    label: args.label ?? (argsRaw === '' ? block.callId : firstLine(argsRaw)),
    prompt: args.prompt,
    output,
    background: args.background || resultIsBackground(output),
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/** State substitution for the collapsed leading slot. */
function leadingFor(state: SubagentRowState): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return <IconAgentPresetOutline16 size={14} />
  }
}

/** Leading disclosure slot: state icon at rest, chevron on hover or while open. */
function disclosureLeading(state: SubagentRowState, open: boolean, expandable: boolean): ReactNode {
  if (open) return <IconChevronDownOutline14 className={css.chevron} />
  const icon = leadingFor(state)
  if (!expandable) return icon
  return (
    <>
      <span className={css.iconIdle}>{icon}</span>
      <IconChevronDownOutline14 className={`${css.chevron} ${css.chevronHover}`} />
    </>
  )
}

/** Visually hidden state copy for the colour-only lifecycle cues. */
function stateStatus(state: SubagentRowState, t: SubagentRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/**
 * Render one `subagent` tool call as an agent card: label, lifecycle, and the
 * prompt/result disclosure.
 * @param props - keyed toolview payload plus the coherence locale seat.
 * @returns the dedicated subagent row.
 */
export function SubagentRow({ block, inspect, t }: SubagentRowProps) {
  const model = subagentRowModel(block)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.prompt !== null || model.output !== null
  const open = expanded && expandable
  const status = stateStatus(model.state, t)
  const summary = model.errorSummary ?? model.label
  const toggleExpand = (): void => {
    setExpanded(value => !value)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const disclosureProps = expandable ? {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': open,
    onClick: toggleExpand,
    onKeyDown: toggleFromKeyboard,
  } : {}
  const leading = disclosureLeading(model.state, open, expandable)
  return (
    <div className={css.card} data-tool="subagent" data-state={model.state}>
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...disclosureProps}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null ? <span className={css.visuallyHidden}>{status}</span> : null}
        <span className={css.title}>{t('row.title')}</span>
        <span className={css.separator} aria-hidden />
        <span className={model.errorSummary === null ? css.summary : `${css.summary} ${css.errorSummary}`}>
          {summary}
        </span>
        {model.background ? <span className={css.badge}>{t('row.background')}</span> : null}
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          {model.prompt !== null ? (
            <section className={css.promptCard} aria-label={t('row.prompt')}>
              <div className={css.sectionHeader}>{t('row.prompt')}</div>
              <pre className={css.prompt}>{model.prompt}</pre>
            </section>
          ) : null}
          {model.output !== null ? (
            <section className={css.resultCard} aria-label={t('row.result')}>
              <div className={css.sectionHeader}>{t('row.result')}</div>
              <pre className={css.result} data-error={model.state === 'error' || undefined}>{model.output}</pre>
            </section>
          ) : null}
          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutline12 />
              Inspect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
