/** App shell state: REST snapshots + WS live events through the pure reducer
 * (WPT-3), one global WS subscription (Q6=A), toast plumbing. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'

import type { ApiClient } from '../api/client'
import { startEventStream, type ConnectionStatus, type SocketLike } from '../api/ws'
import { clearAgentsStale, initialLiveState, reduceEvent, type LiveState } from '../lib/reducer'
import type { AgentStatus, CoreEvent } from '../lib/types'

export interface Toast {
  id: number
  tone: 'info' | 'error' | 'warn'
  text: string
}

export interface ShellState {
  agents: AgentStatus[]
  live: LiveState
  connection: ConnectionStatus
  toasts: Toast[]
}

export type ShellAction =
  | { type: 'ws-event'; event: CoreEvent }
  | { type: 'agents'; list: AgentStatus[] }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'stale-cleared' }
  | { type: 'toast'; toast: Toast }
  | { type: 'toast-dismiss'; id: number }

export const initialShellState: ShellState = {
  agents: [],
  live: initialLiveState,
  connection: 'reconnecting',
  toasts: [],
}

const TOAST_LIMIT = 5

/** Pure — unit-testable without React. */
export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'ws-event': {
      const live = reduceEvent(state.live, action.event)
      if (live === state.live) return state
      const toasts =
        action.event.kind.startsWith('drift.') || action.event.kind === 'orphan.detected'
          ? boundedToasts(state.toasts, {
              id: nextToastId(state.toasts),
              tone: 'warn' as const,
              text: `${action.event.kind}${action.event.agent ? ` — ${action.event.agent}` : ''}`,
            })
          : state.toasts
      return { ...state, live, toasts }
    }
    case 'agents':
      return { ...state, agents: action.list }
    case 'connection':
      return state.connection === action.status ? state : { ...state, connection: action.status }
    case 'stale-cleared':
      return { ...state, live: clearAgentsStale(state.live) }
    case 'toast':
      return { ...state, toasts: boundedToasts(state.toasts, action.toast) }
    case 'toast-dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
  }
}

function nextToastId(toasts: readonly Toast[]): number {
  return toasts.reduce((max, t) => Math.max(max, t.id), 0) + 1
}

function boundedToasts(toasts: readonly Toast[], toast: Toast): Toast[] {
  const next = [...toasts, toast]
  return next.length > TOAST_LIMIT ? next.slice(next.length - TOAST_LIMIT) : next
}

export interface AppStore {
  client: ApiClient
  state: ShellState
  refetchAgents: () => Promise<void>
  toast: (tone: Toast['tone'], text: string) => void
  dismissToast: (id: number) => void
}

const AppContext = createContext<AppStore | null>(null)

export function useApp(): AppStore {
  const store = useContext(AppContext)
  if (!store) throw new Error('useApp outside AppProvider')
  return store
}

export function AppProvider(props: {
  client: ApiClient
  token: string
  children: ReactNode
  /** test seam (WPT-10) */
  socketFactory?: (url: string) => SocketLike
}): ReactNode {
  const { client, token, children, socketFactory } = props
  const [state, dispatch] = useReducer(shellReducer, initialShellState)
  const toastSeq = useRef(1000)

  const refetchAgents = useCallback(async () => {
    try {
      const list = await client.listAgents()
      dispatch({ type: 'agents', list })
    } catch {
      // connection badge already reflects daemon reachability
    }
  }, [client])

  const toast = useCallback((tone: Toast['tone'], text: string) => {
    toastSeq.current += 1
    dispatch({ type: 'toast', toast: { id: toastSeq.current, tone, text } })
  }, [])

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: 'toast-dismiss', id })
  }, [])

  // one global WS subscription (Q6=A); reconnect refetches REST (WPT-4)
  useEffect(() => {
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const handle = startEventStream({
      url: () =>
        `${wsProto}://${window.location.host}/api/events?token=${encodeURIComponent(token)}`,
      onEvent: (event) => dispatch({ type: 'ws-event', event }),
      onStatus: (status) => dispatch({ type: 'connection', status }),
      onConnected: () => {
        void refetchAgents()
      },
      socketFactory,
    })
    return () => handle.stop()
  }, [token, refetchAgents, socketFactory])

  // structural job finished → the agent list is stale (reducer contract)
  useEffect(() => {
    if (state.live.agentsStale) {
      dispatch({ type: 'stale-cleared' })
      void refetchAgents()
    }
  }, [state.live.agentsStale, refetchAgents])

  const store = useMemo<AppStore>(
    () => ({ client, state, refetchAgents, toast, dismissToast }),
    [client, state, refetchAgents, toast, dismissToast],
  )

  return <AppContext.Provider value={store}>{children}</AppContext.Provider>
}
