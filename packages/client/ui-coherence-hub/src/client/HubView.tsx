/** Coherence Hub view: the multi-agent collaboration and memory surface. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
// Coherence wire rows are owned by this suite's host plugin; see client/index.ts.
import type {
  CoherenceIngestSource,
  CoherenceMemoryListResult,
  CoherenceRecallResult,
  CoherenceStatsResult,
  CoherenceWorkspacesResult,
} from 'dsh-coherence/types'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CoherenceHubLocaleKey } from './locales.ts'
import css from './HubView.module.css'

/** Registration-side face closing over the client context. */
export interface CoherenceHubInjected {
  /** Read the suite's point-in-time stats snapshot. */
  stats: (args: { workspaceId?: string }) => Promise<CoherenceStatsResult>
  /** List stored memory entries, newest first. */
  listMemory: (args: {
    layer?: 'working' | 'episodic' | 'semantic'
    limit?: number
    workspaceId?: string
  }) => Promise<CoherenceMemoryListResult>
  /** Keyword-recall memory across the three layers. */
  recallMemory: (args: { query: string; workspaceId?: string }) => Promise<CoherenceRecallResult>
  /** List the registered workspaces the shard selector offers. */
  listWorkspaces: () => Promise<CoherenceWorkspacesResult>
  /** List the registered subagent providers for the delegation form. */
  providers: () => Promise<{ providers: Array<{ name: string; continuable: boolean }> }>
  /** Start one continuable delegation under the given parent session. */
  startDelegation: (args: {
    parentSessionId: SessionId
    provider: string
    label: string
    prompt: string
  }) => Promise<{ childId: SessionId; messageId: string }>
  /** Interrupt one continuable child's current turn. */
  interruptChild: (address: SubagentAddress & { mode: 'continuable' }) => Promise<{ accepted: true }>
  /** Open one catalog child's session. */
  openChild: (address: SubagentAddress) => void
}

/** Full component props assembled by the conversation view slot renderer. */
export type CoherenceHubViewProps =
  ConvViewProps
  & InjectFace<CoherenceHubInjected>
  & PropsLocale<'coherenceHub'>

/** The hub's top-level sections; the trailing trio land in a later release. */
type SectionId = 'agents' | 'delegates' | 'memory' | 'later'
type MemoryLayerFilter = 'all' | 'working' | 'episodic' | 'semantic'

/** Agent label key per managed agent type. */
const AGENT_KEYS = {
  main: 'agentMain',
  'claude-code': 'agentClaudeCode',
  opencode: 'agentOpencode',
  codex: 'agentCodex',
} as const satisfies Record<CoherenceIngestSource['agentType'], CoherenceHubLocaleKey>

/** Routing-hint locale key per known provider name (omo-style lane card, static). */
const PROVIDER_HINTS: Record<string, CoherenceHubLocaleKey> = {
  spawn: 'routeHintSpawn',
  fork: 'routeHintFork',
  acp: 'routeHintAcp',
  'claude-code': 'routeHintClaudeCode',
  codex: 'routeHintCodex',
  'dsh-sdk': 'routeHintDshSdk',
}

/** Memory-state label key per state-machine position. */
const STATE_KEYS = {
  active: 'stateActive',
  outdated: 'stateOutdated',
  contradicted: 'stateContradicted',
  tentative: 'stateTentative',
} as const satisfies Record<CoherenceMemoryListResult['entries'][number]['state'], CoherenceHubLocaleKey>

/** Render one Coherence Hub view. */
export function CoherenceHubView({
  useSessions, stats, listMemory, recallMemory, listWorkspaces, providers, startDelegation,
  interruptChild, openChild, sessionId, t,
}: CoherenceHubViewProps): ReactNode {
  const [section, setSection] = useState<SectionId>('agents')
  const [loadState, setLoadState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; stats: CoherenceStatsResult }
  >({ status: 'loading' })
  const [reload, setReload] = useState(0)
  /** Selected workspace shard; `undefined` reads the legacy shard. */
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => stats({ ...(workspaceId === undefined ? {} : { workspaceId }) })).then(
      (snapshot) => { if (current) setLoadState({ status: 'ready', stats: snapshot }) },
      () => { if (current) setLoadState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [stats, reload, workspaceId])

  return (
    <div className={css.hub}>
      <div className={css.sections} role="tablist">
        {(['agents', 'delegates', 'memory', 'later'] as const).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={css.sectionTab}
            onClick={() => { setSection(id) }}
          >
            {t(id === 'agents'
              ? 'sectionAgents'
              : id === 'delegates'
                ? 'sectionDelegates'
                : id === 'memory'
                  ? 'sectionMemory'
                  : 'sectionLater')}
          </button>
        ))}
      </div>
      {loadState.status === 'loading' && <p className={css.note}>{t('loading')}</p>}
      {loadState.status === 'error' && (
        <p className={css.note}>
          {t('error')}
          {' '}
          <button type="button" className={css.linkButton} onClick={() => { setLoadState({ status: 'loading' }); setReload(v => v + 1) }}>
            {t('retry')}
          </button>
        </p>
      )}
      {loadState.status === 'ready' && section === 'agents' && (
        <AgentsSection stats={loadState.stats} useSessions={useSessions} openChild={openChild} t={t} />
      )}
      {loadState.status === 'ready' && section === 'delegates' && (
        <DelegatesSection
          useSessions={useSessions}
          sessionId={sessionId}
          providers={providers}
          startDelegation={startDelegation}
          interruptChild={interruptChild}
          openChild={openChild}
          t={t}
        />
      )}
      {loadState.status === 'ready' && section === 'memory' && (
        <MemorySection
          stats={loadState.stats}
          listMemory={listMemory}
          recallMemory={recallMemory}
          listWorkspaces={listWorkspaces}
          workspaceId={workspaceId}
          onWorkspaceChange={(id) => { setLoadState({ status: 'loading' }); setWorkspaceId(id) }}
          refreshStats={() => { setLoadState({ status: 'loading' }); setReload(v => v + 1) }}
          t={t}
        />
      )}
      {loadState.status === 'ready' && section === 'later' && (
        <div className={css.placeholder}>
          <h3>{t('placeholderTitle')}</h3>
          <p>{t('placeholderBody')}</p>
        </div>
      )}
    </div>
  )
}

interface AgentsSectionProps {
  stats: CoherenceStatsResult
  useSessions: CoherenceHubViewProps['useSessions']
  openChild: (address: SubagentAddress) => void
  t: CoherenceHubViewProps['t']
}

/** The Agents section: external ingest status plus the live subagent lineage. */
function AgentsSection({ stats, useSessions, openChild, t }: AgentsSectionProps): ReactNode {
  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)

  const children = useMemo(() => {
    const rows: Array<{
      address: SubagentAddress
      label: string
      running: boolean
      mode: SubagentAddress['mode']
    }> = []
    for (const [parentSessionId, catalog] of Object.entries(catalogs)) {
      for (const entry of catalog.entries) {
        if (entry.kind !== 'child') continue
        const summary = summaries[entry.id]
        rows.push({
          address: { parentSessionId: parentSessionId as SessionId, childSessionId: entry.id, mode: entry.mode },
          label: summary?.displayTitle ?? entry.label ?? entry.id,
          running: summary?.running ?? entry.activity === 'running',
          mode: entry.mode,
        })
      }
    }
    return rows
  }, [catalogs, summaries])

  return (
    <div className={css.sectionBody}>
      <h3 className={css.cardTitle}>{t('ingestTitle')}</h3>
      <div className={css.ingestGrid}>
        {stats.ingest.map(source => (
          <div key={source.agentType} className={css.ingestCard}>
            <div className={css.ingestHead}>
              <StateDot state={source.messages > 0 ? 'done' : 'warning'} />
              <span className={css.ingestName}>{t(AGENT_KEYS[source.agentType])}</span>
            </div>
            <span className={css.ingestMeta}>
              {t('ingestMessages').replace('{messages}', String(source.messages))}
              {' · '}
              {source.lastActivityAt === 0
                ? t('neverActive')
                : t('lastActivity').replace('{when}', new Date(source.lastActivityAt).toLocaleString())}
            </span>
          </div>
        ))}
      </div>
      <h3 className={css.cardTitle}>{t('lineageTitle')}</h3>
      {children.length === 0 && <p className={css.note}>{t('lineageEmpty')}</p>}
      <ul className={css.lineageList}>
        {children.map(child => (
          <li key={`${child.address.parentSessionId}:${child.address.childSessionId}`} className={css.lineageRow}>
            <StateDot state={child.running ? 'ongoing' : 'done'} />
            <span className={css.lineageLabel}>{child.label}</span>
            <span className={css.lineageMode}>{child.running ? t('running') : t('idle')}</span>
            <button type="button" className={css.linkButton} onClick={() => { openChild(child.address) }}>
              {t('openSubagent')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface DelegatesSectionProps {
  useSessions: CoherenceHubViewProps['useSessions']
  /** The session the delegation runs under; absent while no session is open. */
  sessionId: SessionId | undefined
  providers: CoherenceHubInjected['providers']
  startDelegation: CoherenceHubInjected['startDelegation']
  interruptChild: CoherenceHubInjected['interruptChild']
  openChild: (address: SubagentAddress) => void
  t: CoherenceHubViewProps['t']
}

/** The Delegates section: the start form, the routing hint, and live delegations. */
function DelegatesSection({
  useSessions, sessionId, providers, startDelegation, interruptChild, openChild, t,
}: DelegatesSectionProps): ReactNode {
  const catalogs = useSessions(state => state.subagentsByParent)
  const summaries = useSessions(state => state.byId)
  const [providerRows, setProviderRows] = useState<Array<{ name: string; continuable: boolean }> | null>(null)
  const [provider, setProvider] = useState('')
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => providers()).then(
      (result) => {
        if (!current) return
        const continuable = result.providers.filter(row => row.continuable)
        setProviderRows(continuable)
        setProvider(previous => (previous === '' ? continuable[0]?.name ?? previous : previous))
      },
      () => { if (current) setProviderRows([]) },
    )
    return () => { current = false }
  }, [providers])

  const children = useMemo(() => {
    const rows: Array<{ address: SubagentAddress & { mode: 'continuable' }; label: string; running: boolean }> = []
    if (sessionId === undefined) return rows
    const catalog = catalogs[sessionId]
    if (catalog === undefined) return rows
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
      const summary = summaries[entry.id]
      rows.push({
        address: { parentSessionId: sessionId, childSessionId: entry.id, mode: 'continuable' },
        label: summary?.displayTitle ?? entry.label,
        running: summary?.running ?? entry.activity === 'running',
      })
    }
    return rows
  }, [catalogs, summaries, sessionId])

  const submit = (): void => {
    if (sessionId === undefined || provider === '' || label.trim() === '' || prompt.trim() === '') return
    setBusy(true)
    setError(null)
    void startDelegation({ parentSessionId: sessionId, provider, label: label.trim(), prompt: prompt.trim() }).then(
      (receipt) => {
        setBusy(false)
        setLabel('')
        setPrompt('')
        openChild({ parentSessionId: sessionId, childSessionId: receipt.childId, mode: 'continuable' })
      },
      (cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  return (
    <div className={css.sectionBody}>
      <h3 className={css.cardTitle}>{t('delegateFormTitle')}</h3>
      {sessionId === undefined && <p className={css.note}>{t('delegateNeedSession')}</p>}
      <form
        className={css.delegateForm}
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <div className={css.shardRow}>
          <label className={css.shardLabel} htmlFor="coherence-hub-provider">{t('delegateProvider')}</label>
          <select
            id="coherence-hub-provider"
            className={css.shardSelect}
            value={provider}
            disabled={sessionId === undefined || providerRows === null}
            onChange={(event) => { setProvider(event.target.value) }}
          >
            {(providerRows ?? []).map(row => <option key={row.name} value={row.name}>{row.name}</option>)}
          </select>
          {provider !== '' && (
            <span className={css.shardHint}>
              {t(PROVIDER_HINTS[provider] ?? 'routeHintDefault')}
            </span>
          )}
        </div>
        <input
          className={css.searchInput}
          value={label}
          placeholder={t('delegateLabelPlaceholder')}
          disabled={sessionId === undefined || busy}
          onChange={(event) => { setLabel(event.target.value) }}
        />
        <textarea
          className={`${css.searchInput} ${css.delegatePrompt}`}
          value={prompt}
          placeholder={t('delegatePromptPlaceholder')}
          rows={4}
          disabled={sessionId === undefined || busy}
          onChange={(event) => { setPrompt(event.target.value) }}
        />
        <button
          type="submit"
          className={css.searchButton}
          disabled={sessionId === undefined || busy || label.trim() === '' || prompt.trim() === ''}
        >
          {busy ? t('delegating') : t('delegateSubmit')}
        </button>
      </form>
      {error !== null && <p className={css.note}>{t('delegateFailed')}: {error}</p>}
      <h3 className={css.cardTitle}>{t('delegatesTitle')}</h3>
      {children.length === 0 && <p className={css.note}>{t('delegatesEmpty')}</p>}
      <ul className={css.lineageList}>
        {children.map(child => (
          <li key={child.address.childSessionId} className={css.lineageRow}>
            <StateDot state={child.running ? 'ongoing' : 'done'} />
            <span className={css.lineageLabel}>{child.label}</span>
            <span className={css.lineageMode}>{child.running ? t('running') : t('idle')}</span>
            <button type="button" className={css.linkButton} onClick={() => { openChild(child.address) }}>
              {t('openSubagent')}
            </button>
            <button
              type="button"
              className={css.linkButton}
              onClick={() => { void interruptChild(child.address) }}
            >
              {t('stopDelegation')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface MemorySectionProps {
  stats: CoherenceStatsResult
  listMemory: CoherenceHubInjected['listMemory']
  recallMemory: CoherenceHubInjected['recallMemory']
  listWorkspaces: CoherenceHubInjected['listWorkspaces']
  /** The selected workspace shard; `undefined` is the legacy shard. */
  workspaceId: string | undefined
  /** Switch the shard every section read goes through. */
  onWorkspaceChange: (workspaceId: string | undefined) => void
  /** Reload the parent stats snapshot so the layer counts track fresh data. */
  refreshStats: () => void
  t: CoherenceHubViewProps['t']
}

/** The Memory section: the shard selector, layer counts, the list, and recall. */
function MemorySection({
  stats, listMemory, recallMemory, listWorkspaces, workspaceId, onWorkspaceChange, refreshStats, t,
}: MemorySectionProps): ReactNode {
  const [layer, setLayer] = useState<MemoryLayerFilter>('all')
  const [list, setList] = useState<CoherenceMemoryListResult['entries'] | null>(null)
  const [workspaces, setWorkspaces] = useState<CoherenceWorkspacesResult | null>(null)
  const [query, setQuery] = useState('')
  const [recall, setRecall] = useState<CoherenceRecallResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listWorkspaces()).then(
      (result) => { if (current) setWorkspaces(result) },
      () => { if (current) setWorkspaces({ workspaces: [] }) },
    )
    return () => { current = false }
  }, [listWorkspaces])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listMemory({
      ...(layer === 'all' ? {} : { layer }),
      limit: 200,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })).then(
      (result) => { if (current) { setList(result.entries); setRecall(null) } },
      () => { if (current) setList([]) },
    )
    return () => { current = false }
  }, [listMemory, layer, workspaceId])

  const counts = stats.memory
  const search = (): void => {
    const trimmed = query.trim()
    if (trimmed === '') return
    setBusy(true)
    void Promise.resolve().then(() => recallMemory({
      query: trimmed,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })).then(
      (result) => { setRecall(result); setBusy(false) },
      () => { setBusy(false) },
    )
  }

  return (
    <div className={css.sectionBody}>
      <div className={css.shardRow}>
        <label className={css.shardLabel} htmlFor="coherence-hub-workspace">{t('workspaceLabel')}</label>
        <select
          id="coherence-hub-workspace"
          className={css.shardSelect}
          value={workspaceId ?? ''}
          onChange={(event) => { onWorkspaceChange(event.target.value === '' ? undefined : event.target.value) }}
        >
          <option value="">{t('workspaceDefault')}</option>
          {(workspaces?.workspaces ?? []).map(ws => (
            <option key={ws.id} value={ws.id} title={ws.path}>{ws.path.split(/[\\/]/).pop() ?? ws.path}</option>
          ))}
        </select>
        <span className={css.shardHint}>{t('workspaceHint')}</span>
      </div>
      <div className={css.layerTabs} role="tablist">
        {(['all', 'working', 'episodic', 'semantic'] as const).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={layer === id}
            className={css.sectionTab}
            onClick={() => { setLayer(id) }}
          >
            {t(id === 'all' ? 'memoryAll' : id === 'working' ? 'layerWorking' : id === 'episodic' ? 'layerEpisodic' : 'layerSemantic')}
            {' '}
            {id === 'all'
              ? `(${counts.working + counts.episodic + counts.semantic})`
              : `(${counts[id]})`}
          </button>
        ))}
      </div>
      <form
        className={css.searchRow}
        onSubmit={(event) => { event.preventDefault(); search() }}
      >
        <input
          className={css.searchInput}
          value={query}
          placeholder={t('searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <button type="submit" className={css.searchButton} disabled={busy}>
          {busy ? t('searching') : t('search')}
        </button>
      </form>
      {recall !== null && <p className={css.note}>{t('searchResults')}: {recall.items.length}</p>}
      <ul className={css.memoryList}>
        {(recall === null ? list ?? [] : recall.items.map(item => ({
          layer: item.layer,
          key: item.key,
          text: item.text,
          subject: item.subject,
          agentType: item.agentType,
          sessionId: item.sessionId,
          importance: item.importance,
          state: item.state,
          tags: [] as readonly string[],
          at: 0,
        }))).map(entry => (
          <li key={entry.key} className={css.memoryRow}>
            <div className={css.memoryHead}>
              <span className={css.layerChip}>
                {t(entry.layer === 'working' ? 'layerWorking' : entry.layer === 'episodic' ? 'layerEpisodic' : 'layerSemantic')}
              </span>
              <span className={css.stateChip}>{t(STATE_KEYS[entry.state])}</span>
              <span className={css.agentChip}>{t(AGENT_KEYS[entry.agentType])}</span>
              <span className={css.importance}>{t('importanceLabel')} {entry.importance.toFixed(2)}</span>
            </div>
            {entry.subject !== undefined && <div className={css.memorySubject}>{entry.subject}</div>}
            <div className={css.memoryText}>{entry.text}</div>
            {entry.tags.length > 0 && (
              <div className={css.tagRow}>
                {entry.tags.map(tag => <span key={tag} className={css.tag}>{tag}</span>)}
              </div>
            )}
          </li>
        ))}
      </ul>
      {(recall === null && (list ?? []).length === 0) && <p className={css.note}>{t('empty')}</p>}
      <button
        type="button"
        className={css.linkButton}
        onClick={() => { refreshStats(); setRecall(null) }}
      >
        {t('retry')}
      </button>
    </div>
  )
}
