/**
 * Session events added by the dsh-coherence plugin. The dsh main agent's memory tool
 * calls log these to its session (Model-visible ⟺ logged); external-agent
 * memory writes go only to the storage domain and never here.
 * @module dsh-coherence/src/session-events
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One memory entry written through a model-facing tool. */
    'memory/write': {
      layer: 'working' | 'episodic' | 'semantic'
      ref: string
      content: string
      importance?: number
      tags?: string[]
    }
    /** One memory recall whose results reached the model. */
    'memory/recall': {
      query: string
      items: Array<{ layer: string; key: string; content: string }>
    }
    /** One memory entry soft-deleted or state-changed through a tool. */
    'memory/forget': {
      layer: 'working' | 'episodic' | 'semantic'
      ref: string
      state: string
    }
    /** One memory status snapshot reached the model. */
    'memory/status': {
      working: number
      episodic: number
      semantic: number
    }
    /** One offline consolidation run through a tool. */
    'memory/consolidate': {
      episodes: number
      claims: number
    }
    /** One codebase-map node stored through a model-facing tool. */
    'codebase-map/upsert': {
      kind: 'folder' | 'file' | 'symbol'
      address: string
      summary: string
    }
    /** One codebase-map read whose result reached the model. */
    'codebase-map/read': {
      items: Array<{ kind: string; address: string; summary: string }>
    }
    /** One worklog write (direction, entry, or handoff) through a tool. */
    'worklog/update': {
      action: 'direction' | 'entry' | 'handoff'
      key: string
    }
    /** One worklog read whose result reached the model. */
    'worklog/read': {
      items: Array<{ key: string; text: string }>
    }
  }
}

export {}
