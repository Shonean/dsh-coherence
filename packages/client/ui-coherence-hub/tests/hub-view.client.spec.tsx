// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoherenceHubView } from '../src/client/HubView.tsx'
import type { CoherenceHubInjected, CoherenceHubViewProps } from '../src/client/HubView.tsx'
import { en, type CoherenceHubLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: CoherenceHubLocaleKey): string => en[key]) as CoherenceHubViewProps['t']

const SESSION_STATE = {
  subagentsByParent: {
    'p1': {
      state: 'ready',
      error: null,
      parentAvailable: true,
      entries: [
        { kind: 'child', id: 'c1', activity: 'running', hasChildren: false, mode: 'continuable', label: 'explore' },
        { kind: 'child', id: 'c2', activity: 'inactive', hasChildren: false, mode: 'one-shot' },
        { kind: 'diagnostic', id: 'd1', reason: 'unavailable' },
      ],
    },
  },
  byId: {
    c1: { id: 'c1', displayTitle: 'explore worker', running: true },
    c2: { id: 'c2', displayTitle: 'one shot child', running: false },
  },
} as never

type Stats = Awaited<ReturnType<CoherenceHubInjected['stats']>>

function props(
  stats: Stats,
  over: {
    listMemory?: CoherenceHubInjected['listMemory']
    recallMemory?: CoherenceHubInjected['recallMemory']
    listWorkspaces?: CoherenceHubInjected['listWorkspaces']
    providers?: CoherenceHubInjected['providers']
    startDelegation?: CoherenceHubInjected['startDelegation']
    interruptChild?: CoherenceHubInjected['interruptChild']
    sessionId?: string
  } = {},
): CoherenceHubViewProps {
  return {
    t,
    useSessions: (selector: (state: never) => unknown) => selector(SESSION_STATE),
    stats: vi.fn(async () => stats),
    listMemory: over.listMemory ?? vi.fn(async () => ({ entries: [] })),
    recallMemory: over.recallMemory ?? vi.fn(async () => ({
      items: [], budgetUsed: { working: 0, episodic: 0, semantic: 0 }, durationMs: 1,
    })),
    listWorkspaces: over.listWorkspaces ?? vi.fn(async () => ({ workspaces: [] })),
    providers: over.providers ?? vi.fn(async () => ({ providers: [] })),
    startDelegation: over.startDelegation ?? vi.fn(async () => ({ childId: 'c1' as never, messageId: 'm1' })),
    interruptChild: over.interruptChild ?? vi.fn(async () => ({ accepted: true as const })),
    openChild: vi.fn(),
    sessionId: over.sessionId,
  } as unknown as CoherenceHubViewProps
}

const STATS: Stats = {
  memory: { working: 2, episodic: 3, semantic: 1 },
  ingest: [
    { agentType: 'main', messages: 0, lastActivityAt: 0 },
    { agentType: 'claude-code', messages: 9798, lastActivityAt: 1_788_175_266_000 },
  ],
}

describe('CoherenceHubView', () => {
  it('renders ingest status cards from the stats snapshot', async () => {
    const view = render(<CoherenceHubView {...props(STATS)} />)
    await screen.findByText(en.ingestTitle)
    expect(screen.getByText(en.agentClaudeCode)).toBeTruthy()
    expect(view.container.textContent).toContain(en.ingestMessages.replace('{messages}', '9798'))
    expect(view.container.textContent).toContain(en.neverActive)
    expect(screen.getByText(en.lineageTitle)).toBeTruthy()
    expect(screen.getByText('explore worker')).toBeTruthy()
    expect(screen.queryByText('d1')).toBeNull()
  })

  it('lists memory rows in the Memory section and recalls by keyword', async () => {
    const listMemory = vi.fn(async () => ({
      entries: [{
        layer: 'episodic', key: 'e:1', text: 'shipped the hub', agentType: 'main',
        sessionId: 's1', importance: 0.8, state: 'active', tags: ['hub'], at: 1_788_175_000_000,
      }],
    })) as unknown as CoherenceHubInjected['listMemory']
    const recallMemory = vi.fn(async () => ({
      items: [{
        layer: 'semantic', key: 's:1', text: 'the hub ships', subject: 'hub',
        agentType: 'main', sessionId: 's1', importance: 0.9, state: 'active', score: 3,
      }],
      budgetUsed: { working: 0, episodic: 0, semantic: 12 },
      durationMs: 2,
    })) as unknown as CoherenceHubInjected['recallMemory']
    render(<CoherenceHubView {...props(STATS, { listMemory, recallMemory })} />)

    fireEvent.click(screen.getByRole('tab', { name: en.sectionMemory }))
    await screen.findByText('shipped the hub')
    expect(listMemory).toHaveBeenCalledWith({ limit: 200 })
    expect(screen.getByText(en.layerEpisodic)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(en.searchPlaceholder), { target: { value: 'hub' } })
    fireEvent.click(screen.getByRole('button', { name: en.search }))
    await screen.findByText('the hub ships')
    expect(screen.getByText('hub')).toBeTruthy()
  })

  it('switches the workspace shard for memory reads', async () => {
    const workspaceId = 'a'.repeat(32)
    const listMemory = vi.fn(async () => ({ entries: [] })) as unknown as CoherenceHubInjected['listMemory']
    const listWorkspaces = vi.fn(async () => ({
      workspaces: [{ id: workspaceId, path: '/repo/app' }],
    })) as unknown as CoherenceHubInjected['listWorkspaces']
    render(<CoherenceHubView {...props(STATS, { listMemory, listWorkspaces })} />)

    fireEvent.click(screen.getByRole('tab', { name: en.sectionMemory }))
    await screen.findByText(en.workspaceLabel)
    expect(listMemory).toHaveBeenCalledWith({ limit: 200 })
    expect(screen.getByTitle('/repo/app')).toBeTruthy()

    // Selecting a workspace threads the shard into every memory read.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: workspaceId } })
    await vi.waitFor(() => {
      expect(listMemory).toHaveBeenCalledWith({ limit: 200, workspaceId })
    })
  })

  it('starts a delegation from the form and opens the child', async () => {
    const startDelegation = vi.fn(async () => ({ childId: 'c-new' as never, messageId: 'm-new' }))
    const openChild = vi.fn()
    render(<CoherenceHubView {...props(STATS, {
      sessionId: 'p1',
      providers: vi.fn(async () => ({ providers: [
        { name: 'spawn', continuable: false },
        { name: 'fork', continuable: true },
      ] })),
      startDelegation,
    })} openChild={openChild} />)

    fireEvent.click(screen.getByRole('tab', { name: en.sectionDelegates }))
    await screen.findByText(en.delegateFormTitle)
    // Only continuable providers are offered.
    expect(screen.queryByRole('option', { name: 'spawn' })).toBeNull()
    expect(screen.getByRole('option', { name: 'fork' })).toBeTruthy()
    // The fork routing hint rides the selected provider.
    await screen.findByText(en.routeHintFork)

    fireEvent.change(screen.getByPlaceholderText(en.delegateLabelPlaceholder), { target: { value: 'explore map' } })
    fireEvent.change(screen.getByPlaceholderText(en.delegatePromptPlaceholder), { target: { value: 'map the storage layer' } })
    fireEvent.click(screen.getByRole('button', { name: en.delegateSubmit }))
    await vi.waitFor(() => {
      expect(startDelegation).toHaveBeenCalledWith({
        parentSessionId: 'p1', provider: 'fork', label: 'explore map', prompt: 'map the storage layer',
      })
    })
    await vi.waitFor(() => {
      expect(openChild).toHaveBeenCalledWith({ parentSessionId: 'p1', childSessionId: 'c-new', mode: 'continuable' })
    })
  })

  it('blocks the delegation form without a parent session', async () => {
    render(<CoherenceHubView {...props(STATS)} />)
    fireEvent.click(screen.getByRole('tab', { name: en.sectionDelegates }))
    await screen.findByText(en.delegateNeedSession)
    expect(screen.getByRole('button', { name: en.delegateSubmit }).hasAttribute('disabled')).toBe(true)
  })

  it('shows the placeholder section for later surfaces', async () => {
    render(<CoherenceHubView {...props(STATS)} />)
    await screen.findByText(en.ingestTitle)
    fireEvent.click(screen.getByRole('tab', { name: en.sectionLater }))
    expect(screen.getByText(en.placeholderTitle)).toBeTruthy()
    expect(screen.getByText(en.placeholderBody)).toBeTruthy()
  })

  it('exposes a retry after a stats failure', async () => {
    const stats = vi.fn<CoherenceHubInjected['stats']>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(STATS)
    render(<CoherenceHubView {...props(STATS, {})} stats={stats} />)
    expect(await screen.findByText(en.error)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: en.retry })[0]!) })
    await screen.findByText(en.ingestTitle)
    expect(stats).toHaveBeenCalledTimes(2)
  })
})
