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
import {
  activeAlertFromEvent,
  alertLabel,
  clearAgentsStale,
  conditionKey,
  initialLiveState,
  reduceEvent,
  type LiveState,
} from '../lib/reducer'
import type { ActiveAlert, AgentStatus, AlertsSnapshot, CoreEvent } from '../lib/types'

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
  /** true once this WS session's replay finished (events.synced) — replayed
   * events must never toast, they are history, not "just happened" */
  synced: boolean
  /** conditions active right now (REST snapshot ∪ post-sync live detections) */
  activeAlerts: Record<string, ActiveAlert>
}

export type ShellAction =
  | { type: 'ws-event'; event: CoreEvent }
  | { type: 'agents'; list: AgentStatus[] }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'stale-cleared' }
  | { type: 'alerts-snapshot'; snapshot: AlertsSnapshot }
  | { type: 'toast'; toast: Toast }
  | { type: 'toast-dismiss'; id: number }

export const initialShellState: ShellState = {
  agents: [],
  live: initialLiveState,
  connection: 'reconnecting',
  toasts: [],
  synced: false,
  activeAlerts: {},
}

const TOAST_LIMIT = 5

/** Pure — unit-testable without React. */
export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'ws-event': {
      const event = action.event
      if (event.kind === 'events.synced') {
        return state.synced ? state : { ...state, synced: true }
      }
      const live = reduceEvent(state.live, event)
      let toasts = state.toasts
      let activeAlerts = state.activeAlerts
      const key = state.synced ? conditionKey(event) : null // replay never toasts
      if (key && (event.kind === 'drift.detected' || event.kind === 'orphan.detected')) {
        if (!(key in activeAlerts)) {
          // a condition that just appeared — toast once, then stay silent while
          // the reconciler re-detects it every cycle
          const alert = activeAlertFromEvent(event, key)
          activeAlerts = { ...activeAlerts, [key]: alert }
          toasts = boundedToasts(toasts, {
            id: nextToastId(toasts),
            tone: 'warn',
            text: alertLabel(alert),
          })
        }
      } else if (key && event.kind === 'drift.remediated') {
        if (key in activeAlerts) {
          activeAlerts = { ...activeAlerts }
          delete activeAlerts[key]
        }
        toasts = boundedToasts(toasts, {
          id: nextToastId(toasts),
          tone: 'info',
          text: `drift remediated — ${event.agent ?? ''}`,
        })
      }
      if (live === state.live && toasts === state.toasts && activeAlerts === state.activeAlerts) {
        return state
      }
      return { ...state, live, toasts, activeAlerts }
    }
    case 'agents':
      return { ...state, agents: action.list }
    case 'connection':
      // any transition invalidates the replay/live boundary of the old socket
      return state.connection === action.status
        ? state
        : { ...state, connection: action.status, synced: false }
    case 'stale-cleared':
      return { ...state, live: clearAgentsStale(state.live) }
    case 'alerts-snapshot': {
      // authoritative "active right now" set — replaces the map; only
      // conditions we did not already know about toast (first load: all)
      const activeAlerts: Record<string, ActiveAlert> = {}
      let toasts = state.toasts
      for (const alert of action.snapshot.alerts) {
        activeAlerts[alert.key] = alert
        if (!(alert.key in state.activeAlerts)) {
          toasts = boundedToasts(toasts, {
            id: nextToastId(toasts),
            tone: 'warn',
            text: alertLabel(alert),
          })
        }
      }
      return { ...state, activeAlerts, toasts }
    }
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

/** Resolution poll cadence — matches the daemon's default reconcile interval. */
export const ALERTS_POLL_MS = 30_000
const ALERTS_REFETCH_DEBOUNCE_MS = 500

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

  const refetchAlerts = useCallback(async () => {
    try {
      const snapshot = await client.getAlerts()
      dispatch({ type: 'alerts-snapshot', snapshot })
    } catch {
      // keep the last successful snapshot (U4-REL); badge covers reachability
    }
  }, [client])

  // drift/orphan live events also refresh the snapshot (debounced) so
  // remediation/resolution converges faster than the poll below
  const alertsRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleAlertsRefetch = useCallback(() => {
    if (alertsRefetchTimer.current) return
    alertsRefetchTimer.current = setTimeout(() => {
      alertsRefetchTimer.current = null
      void refetchAlerts()
    }, ALERTS_REFETCH_DEBOUNCE_MS)
  }, [refetchAlerts])
  useEffect(
    () => () => {
      if (alertsRefetchTimer.current) clearTimeout(alertsRefetchTimer.current)
    },
    [],
  )

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
      onEvent: (event) => {
        dispatch({ type: 'ws-event', event })
        if (event.kind.startsWith('drift.') || event.kind === 'orphan.detected') {
          scheduleAlertsRefetch()
        }
      },
      onStatus: (status) => dispatch({ type: 'connection', status }),
      onConnected: () => {
        void refetchAgents()
        void refetchAlerts() // FR-3: what is REALLY broken right now
      },
      socketFactory,
    })
    return () => handle.stop()
  }, [token, refetchAgents, refetchAlerts, scheduleAlertsRefetch, socketFactory])

  // structural job finished → the agent list is stale (reducer contract)
  useEffect(() => {
    if (state.live.agentsStale) {
      dispatch({ type: 'stale-cleared' })
      void refetchAgents()
    }
  }, [state.live.agentsStale, refetchAgents])

  // Q4=A: while anything is active, poll at the reconcile cadence so resolved
  // conditions disappear without a refresh; zero polling when all is quiet
  const hasActiveAlerts = Object.keys(state.activeAlerts).length > 0
  useEffect(() => {
    if (!hasActiveAlerts) return
    const id = setInterval(() => {
      void refetchAlerts()
    }, ALERTS_POLL_MS)
    return () => clearInterval(id)
  }, [hasActiveAlerts, refetchAlerts])

  const store = useMemo<AppStore>(
    () => ({ client, state, refetchAgents, toast, dismissToast }),
    [client, state, refetchAgents, toast, dismissToast],
  )

  return <AppContext.Provider value={store}>{children}</AppContext.Provider>
}
