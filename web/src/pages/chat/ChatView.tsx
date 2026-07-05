/** Conversation view (S-U4-4, F6) — redesigned (§6.4, Q4=A): full-height
 * three-pane layout (sessions | conversation | meta rail), markdown-rendered
 * assistant turns, tool-call chips.
 *
 * W7 single source of truth: entering, switching or finishing a turn always
 * re-hydrates the transcript from GET api/sessions/{id}/messages — local
 * streaming buffers are render-only and are discarded on re-hydration.
 * The turn runs on POST api/sessions/{id}/chat/stream — one call whose SSE
 * replays the session's native history server-side (tool results, tool_calls,
 * reasoning, images), so no conversation_history is assembled client-side;
 * approval/stop reuse /v1/runs/{run_id}/approval|stop keyed on the run_id from
 * the stream's run.started. The run state machine is the pure lib/chatMachine
 * (PU4-2) and this component merely executes the actions it returns. */

import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  ChevronsUpDown,
  Cog,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link, useBlocker, useParams } from 'react-router-dom'

import {
  createSession,
  deleteSession,
  fetchMessages,
  listSessions,
  renameSession,
  sendApproval,
  stopRun,
  streamSessionChat,
} from '../../api/agentApi'
import { ApiError } from '../../api/client'
import { Collapsible } from '../../components/Collapsible'
import { ConfirmModal } from '../../components/ConfirmModal'
import { Markdown } from '../../components/lazy'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { INPUT_CLASS } from '../../components/ui/Field'
import {
  APPROVAL_CHOICES,
  transition,
  type ApprovalChoice,
  type ChatState,
} from '../../lib/chatMachine'
import { INITIAL_WINDOW, growWindow, isPinned, windowStart } from '../../lib/chatScroll'
import {
  addNote,
  appendReasoning,
  appendText,
  completeTool,
  EMPTY_TURN,
  fallbackText,
  startTool,
  turnIsEmpty,
  type LiveToolCall,
  type LiveTurn,
} from '../../lib/liveTurn'
import { deriveSessionTitle, formatCost, timeAgo } from '../../lib/format'
import { redact } from '../../lib/redact'
import {
  argsSummary,
  failureHint,
  parseToolArgs,
  parseToolResult,
  type FieldEntry,
  type ResultView,
} from '../../lib/toolFormat'
import {
  transcriptFromMessages,
  type TranscriptItem,
  type TranscriptToolCall,
} from '../../lib/transcript'
import type { SessionInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { loadPrefs, savePrefs } from '../../state/prefs'

const DELTA_LIMIT = 1_000_000

const fmt = (n: number): string => n.toLocaleString('en-US')

// timeAgo now lives in lib/format (parses fractional epoch — the raw-id bug fix)

/** FR-4: grow the composer with its content up to ~8 lines (matches the
 * `max-h-52` cap = 208px), after which it scrolls internally. */
const COMPOSER_MAX_HEIGHT_PX = 208

function autoGrowComposer(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
}

export function ChatView(): ReactNode {
  const params = useParams<{ name: string }>()
  const agent = params.name ?? ''
  const { client, state, toast, refetchAgents } = useApp()

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [turn, setTurn] = useState<LiveTurn>(EMPTY_TURN)
  const [input, setInput] = useState('')
  const [approval, setApproval] = useState<{ runId: string; summary: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // machine state needs synchronous access inside the stream loop
  const machineRef = useRef<ChatState>('idle')
  const runIdRef = useRef<string | null>(null)
  // Stop clicked before run.started delivers the run_id: remember it and fire
  // the stop the moment run_id arrives (the run_id is now async on the stream).
  const pendingStopRef = useRef(false)
  const [machineUi, setMachineUi] = useState<ChatState>('idle')

  // FR-1/FR-2 (chat-ux): lazy render window over the transcript + bottom
  // pinning. Pinned lives in a ref — it changes on every scroll frame and
  // must never re-render; the badge is its only rendered projection.
  const [visibleCount, setVisibleCount] = useState(INITIAL_WINDOW)
  const [showNewBadge, setShowNewBadge] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const growAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const transcriptRef = useRef<TranscriptItem[]>([])
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const wasStreamingRef = useRef(false)

  function setMachine(state: ChatState): void {
    machineRef.current = state
    setMachineUi(state)
  }

  const streaming = machineUi !== 'idle'

  // leaving mid-stream needs an explicit confirmation (the run continues
  // server-side and is recoverable via re-hydration — W7)
  const blocker = useBlocker(streaming)

  // Session usage is hermes-native and cumulative: it rides on the session
  // object from listSessions. Loaded on select/first render and refreshed by
  // refreshSessions() at the end of every turn — no client-side token math.
  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  const refreshSessions = useCallback(async (): Promise<SessionInfo[]> => {
    const list = await listSessions(client, agent)
    setSessions(list)
    return list
  }, [client, agent])

  const hydrate = useCallback(
    async (sessionId: string, opts?: { preserveView?: boolean }) => {
      // W7: server store is the single source — discard any local transcript
      const messages = await fetchMessages(client, agent, sessionId)
      const items = transcriptFromMessages(messages)
      const grewBy = Math.max(0, items.length - transcriptRef.current.length)
      transcriptRef.current = items
      setTranscript(items)
      setTurn(EMPTY_TURN)
      if (opts?.preserveView && !pinnedRef.current) {
        // end-of-turn refresh while the user reads older history: grow the
        // window by the appended turn so the same items stay mounted, and let
        // the content effect raise the badge instead of yanking the viewport.
        setVisibleCount((count) => count + grewBy)
        return
      }
      setVisibleCount(INITIAL_WINDOW)
      pinnedRef.current = true
      setShowNewBadge(false)
      queueMicrotask(() => {
        const el = scrollerRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    },
    [client, agent],
  )

  const selectSession = useCallback(
    async (sessionId: string) => {
      setActiveId(sessionId)
      try {
        await hydrate(sessionId)
        setLoadError(null)
      } catch (error) {
        setLoadError(error instanceof ApiError ? error.message : 'failed to load session')
      }
    },
    [hydrate],
  )

  useEffect(() => {
    void refetchAgents() // the switcher + header need the agent's live status
  }, [refetchAgents])

  // resume this conversation next time /chat is opened cold
  useEffect(() => {
    if (agent) savePrefs({ ...loadPrefs(), lastChatAgent: agent })
  }, [agent])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await refreshSessions()
        if (cancelled) return
        const latest = list[0]
        if (latest) await selectSession(latest.id)
        setLoadError(null)
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof ApiError ? `agent unreachable: ${error.message}` : 'agent unreachable',
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshSessions, selectSession])

  // FR-2: follow the stream while pinned; otherwise leave the viewport alone
  // and surface the Slack-style badge. Fires on every content change
  // (stream deltas, tool chips, notes, hydration).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
    else setShowNewBadge(true)
  }, [transcript, turn])

  // FR-1 (Q2=A): grow the window when the top sentinel nears the viewport;
  // snapshot the pre-grow geometry so the layout effect below can anchor.
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const root = scrollerRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisibleCount((count) => {
          const total = transcriptRef.current.length
          if (count >= total) return count
          const el = scrollerRef.current
          if (el) growAnchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
          return growWindow(count, total)
        })
      },
      { root, rootMargin: '160px 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  // FR-1: scroll anchoring — offset by the height the prepended chunk added
  // so the viewport keeps showing the same items (no jump).
  useLayoutEffect(() => {
    const anchor = growAnchorRef.current
    const el = scrollerRef.current
    if (!anchor || !el) return
    growAnchorRef.current = null
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight)
  }, [visibleCount])

  // FR-3: when the turn finishes while the user is following along (pinned),
  // hand the keyboard back to the composer for the next turn.
  useEffect(() => {
    if (wasStreamingRef.current && !streaming && pinnedRef.current) {
      composerRef.current?.focus()
    }
    wasStreamingRef.current = streaming
  }, [streaming])

  // FR-4: composer auto-grow collapses back once the input empties (send/clear)
  useEffect(() => {
    const el = composerRef.current
    if (el && input === '') el.style.height = 'auto'
  }, [input])

  function handleScroll(): void {
    const el = scrollerRef.current
    if (!el) return
    pinnedRef.current = isPinned(el.scrollHeight - el.scrollTop - el.clientHeight)
    if (pinnedRef.current) setShowNewBadge(false)
  }

  function jumpToLatest(): void {
    const el = scrollerRef.current
    if (!el) return
    pinnedRef.current = true
    setShowNewBadge(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  async function newSession(): Promise<void> {
    try {
      const id = await createSession(client, agent)
      await refreshSessions()
      await selectSession(id)
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'failed to create session')
    }
  }

  async function submit(): Promise<void> {
    const text = input.trim()
    if (!text) return
    const [next, action] = transition(machineRef.current, 'user_message')
    if (action !== 'start_turn') return // composer is gated to idle
    setMachine(next)
    setInput('')
    setTurn({ ...EMPTY_TURN, userText: text })
    // sending your own message always jumps to the bottom (Slack/ChatGPT parity)
    pinnedRef.current = true
    setShowNewBadge(false)
    // CLI parity (U3 Q4=A): no session yet → create one lazily on first message
    let sessionId = activeId
    try {
      if (!sessionId) {
        sessionId = await createSession(client, agent)
        setActiveId(sessionId)
        void refreshSessions()
      }
      // sessions/chat/stream replays the session's native history server-side
      // (tool results, tool_calls, reasoning, images) — no client-side
      // conversation_history assembly. The run_id arrives on the stream
      // (run.started) and is what /v1/runs/{id}/approval|stop key on.
      await consumeStream(sessionId, text)
    } catch (error) {
      const message =
        error instanceof ApiError
          ? `turn failed: ${error.message}`
          : 'connection lost — the session is preserved'
      pushNote(message)
      // the finally re-hydrates from the server (W7), which wipes the live
      // buffer — on a partial outage (POST failed but GET works) that erases the
      // note above and the user's message. Surface the failure on a persistent
      // channel (toast survives hydrate) and put the message back in the composer.
      toast('error', message)
      setInput(text)
    } finally {
      setMachine('idle')
      runIdRef.current = null
      pendingStopRef.current = false
      setApproval(null)
      // turn is over: the server store has the authoritative record (W7) —
      // re-hydrate so tool results/failure details replace the live buffers.
      // preserveView: if the user scrolled up mid-stream, don't yank them.
      if (sessionId) {
        try {
          await hydrate(sessionId, { preserveView: true })
          await refreshSessions()
        } catch {
          // hydration failure keeps the live buffers visible; badge shows reachability
        }
      }
    }
  }

  function pushNote(note: string): void {
    setTurn((t) => addNote(t, note))
  }

  async function consumeStream(sessionId: string, message: string): Promise<void> {
    await streamSessionChat(client, agent, sessionId, message, (event) => {
      const payload = event.payload
      switch (event.kind) {
        case 'run.started': {
          // the run_id the /v1/runs/{id}/approval|stop endpoints key on —
          // captured here (there is no separate startRun response now)
          const runId = typeof payload['run_id'] === 'string' ? payload['run_id'] : ''
          if (runId) {
            runIdRef.current = runId
            // a Stop pressed before run_id arrived was deferred — fire it now
            if (pendingStopRef.current) {
              pendingStopRef.current = false
              stopRun(client, agent, runId).catch((error: unknown) => {
                toast(
                  'warn',
                  error instanceof ApiError ? `stop failed: ${error.message}` : 'stop failed',
                )
              })
            }
          }
          break
        }
        case 'assistant.delta': {
          const delta = typeof payload['delta'] === 'string' ? payload['delta'] : ''
          setTurn((t) => appendText(t, redact(delta, DELTA_LIMIT)))
          break
        }
        case 'tool.progress': {
          // reasoning streams live as tool.progress{_thinking} (Q4=B); other
          // tool_name progress is arg-streaming detail we don't render live
          if (payload['tool_name'] === '_thinking') {
            const delta = typeof payload['delta'] === 'string' ? payload['delta'] : ''
            setTurn((t) => appendReasoning(t, redact(delta, DELTA_LIMIT)))
          }
          break
        }
        case 'tool.started': {
          const preview = redact(String(payload['preview'] ?? '')).slice(0, 120)
          const tool = String(payload['tool_name'] ?? '?')
          setTurn((t) => startTool(t, tool, preview))
          break
        }
        case 'tool.completed':
        case 'tool.failed': {
          // sessions stream carries no live duration; the full args/result +
          // timing arrive with end-of-turn W7 re-hydration
          const tool = String(payload['tool_name'] ?? '?')
          setTurn((t) => completeTool(t, tool, event.kind === 'tool.failed', ''))
          break
        }
        case 'approval.request': {
          const runId =
            typeof payload['run_id'] === 'string' ? payload['run_id'] : runIdRef.current
          const [next, action] = transition(machineRef.current, 'approval_request')
          setMachine(next)
          if (action === 'prompt_approval' && runId) {
            const summary = redact(
              String(
                payload['command'] ??
                  payload['description'] ??
                  payload['tool_name'] ??
                  'tool execution',
              ),
            ).slice(0, 200)
            setApproval({ runId, summary })
          } else if (action === 'auto_deny' && runId) {
            sendApprovalSafe(runId, 'deny')
          }
          break
        }
        case 'assistant.completed': {
          // final content — reply fallback for turns with no assistant.delta;
          // fallbackText no-ops once any reply text has streamed (never echoes)
          const content = String(payload['content'] ?? '')
          setTurn((t) => fallbackText(t, redact(content, DELTA_LIMIT)))
          break
        }
        case 'error':
          pushNote(`run failed: ${redact(String(payload['message'] ?? 'unknown'))}`)
          break
        // run.completed (usage/messages), message.started, done: lifecycle —
        // end-of-turn W7 re-hydration is the transcript's source of truth
        default:
          break // unknown kinds ignored (forward compatibility)
      }
    })
    const [next] = transition(machineRef.current, 'stream_end')
    setMachine(next)
  }

  /** Fire an approval decision, swallowing network failure with a toast (the
   * machine transition already happened) — mirrors stopRun's .catch so these
   * never surface as unhandled rejections. */
  function sendApprovalSafe(runId: string, choice: string): void {
    sendApproval(client, agent, runId, choice).catch((error: unknown) => {
      toast('warn', error instanceof ApiError ? `approval failed: ${error.message}` : 'approval failed')
    })
  }

  function interrupt(): void {
    const runId = runIdRef.current
    const [next, action] = transition(machineRef.current, 'interrupt')
    setMachine(next)
    if (action === 'send_stop') {
      pushNote('stopping current turn — session preserved')
      if (runId) {
        stopRun(client, agent, runId).catch((error: unknown) => {
          toast('warn', error instanceof ApiError ? `stop failed: ${error.message}` : 'stop failed')
        })
      } else {
        // run.started hasn't delivered the run_id yet — stop as soon as it does
        pendingStopRef.current = true
      }
    } else if (action === 'auto_deny' && runId) {
      setApproval(null)
      sendApprovalSafe(runId, 'deny')
    }
  }

  function answerApproval(choice: ApprovalChoice): void {
    if (!approval) return
    sendApprovalSafe(approval.runId, choice)
    setApproval(null)
    const [next] = transition(machineRef.current, 'approval_answered')
    setMachine(next)
  }

  async function doRename(): Promise<void> {
    if (!renameTarget) return
    try {
      await renameSession(client, agent, renameTarget.id, renameTarget.title)
      await refreshSessions()
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'rename failed')
    } finally {
      setRenameTarget(null)
    }
  }

  async function doDelete(): Promise<void> {
    if (!deleteTarget) return
    try {
      await deleteSession(client, agent, deleteTarget.id)
      const list = await refreshSessions()
      if (activeId === deleteTarget.id) {
        const latest = list[0]
        if (latest) await selectSession(latest.id)
        else {
          setActiveId(null)
          transcriptRef.current = []
          setTranscript([])
        }
      }
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'delete failed')
    } finally {
      setDeleteTarget(null)
    }
  }

  const agentLive = state.live.agents[agent]
  const agentListed = state.agents.find((a) => a.name === agent)
  // FR-1: only the newest `visibleCount` transcript items are mounted; keys
  // are absolute indices so growing the window never remounts existing items.
  const mountedFrom = windowStart(transcript.length, visibleCount)

  return (
    <div className="flex h-full" data-testid="chat-view">
      {/* ── sessions pane ─────────────────────────────────────────────── */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-panel">
        <AgentSwitcher current={agent} />
        <div className="border-b border-edge p-3">
          <Button
            variant="outline"
            testId="chat-new-session-button"
            className="w-full"
            onClick={() => void newSession()}
          >
            <Plus size={14} aria-hidden /> New session
          </Button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto p-2" data-testid="chat-session-list">
          {sessions.map((session) => (
            <li key={session.id} className="group relative">
              <button
                data-testid={`chat-session-${session.id}-button`}
                onClick={() => void selectSession(session.id)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  session.id === activeId ? 'bg-accent/12 text-accent' : 'text-ink hover:bg-panel-2'
                }`}
              >
                <span className="block truncate pr-10 font-medium">
                  {deriveSessionTitle({ title: session.title, startedAt: session.started_at })}
                </span>
                <span className="block truncate text-xs text-ink-faint">
                  {timeAgo(session.last_active ?? session.started_at)}
                </span>
              </button>
              <div className="absolute top-1/2 right-2 hidden -translate-y-1/2 gap-1 group-hover:flex">
                <button
                  data-testid={`chat-session-${session.id}-rename-button`}
                  className="rounded p-1 text-ink-faint hover:bg-panel hover:text-ink"
                  title="rename"
                  onClick={() => setRenameTarget({ id: session.id, title: session.title ?? '' })}
                >
                  <Pencil size={12} aria-hidden />
                </button>
                <button
                  data-testid={`chat-session-${session.id}-delete-button`}
                  className="rounded p-1 text-ink-faint hover:bg-panel hover:text-bad"
                  title="delete"
                  onClick={() => setDeleteTarget(session)}
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <SessionUsagePanel session={activeSession} agent={agent} />
      </aside>

      {/* ── conversation ──────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-edge bg-panel px-6 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {activeSession
                ? deriveSessionTitle({
                    title: activeSession.title,
                    startedAt: activeSession.started_at,
                  })
                : 'New conversation'}
            </p>
            <p className="truncate text-xs text-ink-dim">
              chat with{' '}
              <Link
                to={`/agents/${encodeURIComponent(agent)}`}
                className="font-medium text-ink hover:text-accent"
              >
                {agent}
              </Link>
              {activeSession?.last_active ? <> · {timeAgo(activeSession.last_active)}</> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge value={agentLive?.process ?? agentListed?.process ?? 'unknown'} />
            <StatusBadge value={agentLive?.health ?? agentListed?.health ?? 'unknown'} />
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto"
            data-testid="chat-transcript"
          >
            <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
              <div ref={topSentinelRef} aria-hidden />
              {mountedFrom > 0 && (
                <p
                  className="text-center text-xs text-ink-faint"
                  data-testid="chat-earlier-indicator"
                >
                  {fmt(mountedFrom)} earlier message{mountedFrom === 1 ? '' : 's'} — scroll up to
                  load
                </p>
              )}
              {loadError && (
                <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{loadError}</p>
              )}
              {!loadError && !activeId && (
                <div className="py-16 text-center">
                  <p className="text-sm font-medium text-ink">Start a conversation</p>
                  <p className="mt-1 text-xs text-ink-dim">
                    Just type below — a session is created automatically.
                  </p>
                </div>
              )}
              {transcript.slice(mountedFrom).map((item, index) => (
                <TranscriptBlock key={mountedFrom + index} item={item} />
              ))}
              <LiveTurnBlock turn={turn} streaming={streaming} />
            </div>
          </div>
          {showNewBadge && (
            <button
              data-testid="chat-new-messages-badge"
              onClick={jumpToLatest}
              className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent-strong px-3.5 py-1.5 text-xs font-medium text-white shadow-lg shadow-accent-strong/30 transition-transform hover:scale-105"
            >
              <ArrowDown size={12} aria-hidden /> New messages
            </button>
          )}
        </div>

        {approval && (
          <div className="border-t border-edge bg-panel px-6 py-3">
            <div
              data-testid="chat-approval-card"
              className="mx-auto max-w-3xl rounded-xl border border-warn/50 bg-warn/10 p-3.5 text-sm"
            >
              <p className="mb-2.5 flex items-start gap-2 font-medium">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                approval requested: <span className="font-mono text-xs">{approval.summary}</span>
              </p>
              <div className="flex gap-2">
                {APPROVAL_CHOICES.map((choice) => (
                  <Button
                    key={choice}
                    size="xs"
                    variant={choice === 'deny' ? 'outline' : 'primary'}
                    testId={`chat-approval-${choice}-button`}
                    onClick={() => answerApproval(choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}

        <footer className="border-t border-edge bg-panel px-6 pt-4 pb-3">
          <div className="mx-auto max-w-3xl">
            {/* FR-4 (Q3=A): one rounded surface — borderless auto-growing
                textarea + integrated round send/stop button, focus ring on
                the container. Typing stays enabled mid-stream; submitting is
                still gated to idle by the chat machine. */}
            <div className="flex items-end gap-2 rounded-2xl border border-edge bg-surface px-4 py-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
              <textarea
                ref={composerRef}
                data-testid="chat-composer-input"
                rows={1}
                className="max-h-52 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 placeholder:text-ink-faint focus:outline-none"
                placeholder={`Message ${agent}…`}
                aria-label={`Message ${agent}`}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  autoGrowComposer(e.currentTarget)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void submit() // no-op unless idle (machine gate)
                  }
                }}
              />
              {streaming ? (
                <button
                  data-testid="chat-stop-button"
                  aria-label={machineUi === 'stopping' ? 'Stopping' : 'Stop the current turn'}
                  title={machineUi === 'stopping' ? 'Stopping…' : 'Stop the current turn'}
                  disabled={machineUi === 'stopping'}
                  onClick={interrupt}
                  className="mb-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-bad text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
                >
                  {machineUi === 'stopping' ? (
                    <Loader2 size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <Square size={13} aria-hidden />
                  )}
                </button>
              ) : (
                <button
                  data-testid="chat-send-button"
                  aria-label="Send message"
                  title="Send (Enter)"
                  disabled={!input.trim()}
                  onClick={() => void submit()}
                  className="mb-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-brand-gradient text-white shadow-sm shadow-accent/30 transition-all hover:brightness-110 disabled:pointer-events-none disabled:opacity-35"
                >
                  <ArrowUp size={15} aria-hidden />
                </button>
              )}
            </div>
            <p className="mt-1.5 text-center text-[11px] text-ink-faint">
              {streaming
                ? 'turn in progress — you can type your next message'
                : 'Enter to send · Shift+Enter for newline'}
            </p>
          </div>
        </footer>
      </section>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete session"
        body={`Delete session ${deleteTarget ? deleteTarget.title || deleteTarget.id : ''}? The agent-side record is removed.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      {renameTarget && (
        <ConfirmModal
          open
          title="Rename session"
          body={
            <input
              data-testid="chat-rename-input"
              className={INPUT_CLASS}
              value={renameTarget.title}
              onChange={(e) => setRenameTarget({ id: renameTarget.id, title: e.target.value })}
              autoFocus
            />
          }
          confirmLabel="Rename"
          onConfirm={() => void doRename()}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      <ConfirmModal
        open={blocker.state === 'blocked'}
        title="Turn in progress"
        body="A turn is still streaming. If you leave, it keeps running on the agent and the result will be in the session when you come back."
        confirmLabel="Leave anyway"
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
        onCancel={() => blocker.state === 'blocked' && blocker.reset()}
      />
    </div>
  )
}

/** Agent switcher in the conversation's left rail — replaces the old blocking
 * /chat picker page. Native <details> popover; each row links to that agent's
 * conversation (keeps chat-agent-<name>-link). */
function AgentSwitcher(props: { current: string }): ReactNode {
  const { state } = useApp()
  const live = state.live.agents
  return (
    <details className="group border-b border-edge [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 hover:bg-panel-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent/12 text-accent">
          <Bot size={15} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{props.current}</span>
        <ChevronsUpDown size={14} className="shrink-0 text-ink-faint" aria-hidden />
      </summary>
      <ul className="border-t border-edge p-1">
        {state.agents.map((a) => (
          <li key={a.name}>
            <Link
              data-testid={`chat-agent-${a.name}-link`}
              to={`/chat/${encodeURIComponent(a.name)}`}
              className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm ${
                a.name === props.current
                  ? 'bg-accent/10 text-accent'
                  : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
              }`}
            >
              <span className="min-w-0 truncate">{a.name}</span>
              <StatusBadge value={live[a.name]?.process ?? a.process} />
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Session usage — the single, labeled placement (was duplicated in the header
 * and the 2xl meta rail). Cost hides $0 via formatCost; deeplinks to the
 * agent's Observability scope for full history. */
function SessionUsagePanel(props: { session: SessionInfo | null; agent: string }): ReactNode {
  const { session } = props
  const has = session != null
  return (
    <div className="border-t border-edge p-3" data-testid="chat-session-usage">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-medium tracking-wide text-ink-faint uppercase">
          Session usage
        </span>
        <Link
          to={`/observability/${encodeURIComponent(props.agent)}`}
          className="inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline"
        >
          details <ArrowUpRight size={11} aria-hidden />
        </Link>
      </div>
      {has && session ? (
        <dl className="space-y-1 text-xs">
          <UsageStat label="input" value={session.input_tokens} />
          <UsageStat label="cache read" value={session.cache_read_tokens} />
          <UsageStat label="output" value={session.output_tokens} />
          <div className="flex justify-between border-t border-edge pt-1">
            <dt className="text-ink-dim">est. cost</dt>
            <dd className="font-mono tabular-nums">{formatCost(session.estimated_cost_usd)}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-xs text-ink-faint">no active session</p>
      )}
    </div>
  )
}

function UsageStat(props: { label: string; value: number | null | undefined }): ReactNode {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-dim">{props.label}</dt>
      <dd className="font-mono tabular-nums">{fmt(props.value ?? 0)}</dd>
    </div>
  )
}

/** Bound for expanded args/output blocks — long outputs scroll inside the
 * card; beyond this they are truncated (secrets always masked first-class
 * via redact). */
const RESULT_LIMIT = 4000

function StatusIcon(props: { state: 'running' | 'ok' | 'failed' | 'pending' }): ReactNode {
  if (props.state === 'running')
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" aria-hidden />
  if (props.state === 'ok') return <Check size={12} className="shrink-0 text-ok" aria-hidden />
  if (props.state === 'failed') return <X size={12} className="shrink-0 text-bad" aria-hidden />
  return <Cog size={12} className="shrink-0 text-ink-faint" aria-hidden />
}

function CodeBlock(props: { text: string; error?: boolean }): ReactNode {
  return (
    <pre
      className={`max-h-64 overflow-auto rounded-md px-2.5 py-2 font-mono text-xs whitespace-pre-wrap ${
        props.error ? 'bg-bad/10 text-bad' : 'bg-surface text-ink-dim'
      }`}
    >
      {redact(props.text, RESULT_LIMIT)}
    </pre>
  )
}

function FieldGrid(props: { fields: FieldEntry[] }): ReactNode {
  if (props.fields.length === 0) return <p className="text-xs text-ink-faint italic">(empty)</p>
  return (
    <dl className="space-y-1">
      {props.fields.map((field) => (
        <div key={field.key} className="flex gap-2">
          <dt className="w-24 shrink-0 pt-0.5 text-[11px] break-all text-ink-faint">{field.key}</dt>
          <dd className="min-w-0 flex-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-dim">
            {redact(field.value, RESULT_LIMIT) || '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SectionTitle(props: { children: ReactNode }): ReactNode {
  return (
    <h4 className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">
      {props.children}
    </h4>
  )
}

/** Expanded card body: Arguments (smart-formatted, Q2=A) + Result. */
function ToolCardBody(props: { args: string | null; result: ResultView | null }): ReactNode {
  const argsView = props.args !== null ? parseToolArgs(props.args) : null
  const result = props.result
  return (
    <div className="space-y-2.5 border-t border-edge/70 px-3 py-2.5">
      {argsView && (
        <section data-testid="chat-tool-card-args" className="space-y-1">
          <SectionTitle>Arguments</SectionTitle>
          {argsView.kind === 'fields' ? (
            <FieldGrid fields={argsView.fields} />
          ) : (
            <CodeBlock text={argsView.text} />
          )}
        </section>
      )}
      <section data-testid="chat-tool-card-result" className="space-y-1">
        <div className="flex items-center gap-2">
          <SectionTitle>Result</SectionTitle>
          {result?.kind === 'terminal' && result.exitCode !== null && (
            <span
              className={`rounded-full px-1.5 py-px font-mono text-[10px] ${
                result.exitCode === 0 ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'
              }`}
            >
              exit {result.exitCode}
            </span>
          )}
        </div>
        {!result && <p className="text-xs text-ink-faint italic">no result</p>}
        {result?.kind === 'terminal' && (
          <>
            {result.output && <CodeBlock text={result.output} />}
            {result.error && <CodeBlock text={result.error} error />}
            {!result.output && !result.error && (
              <p className="text-xs text-ink-faint italic">(empty output)</p>
            )}
          </>
        )}
        {result?.kind === 'fields' && <FieldGrid fields={result.fields} />}
        {result?.kind === 'raw' &&
          (result.text.trim() ? (
            <CodeBlock text={result.text} error={result.failed} />
          ) : (
            <p className="text-xs text-ink-faint italic">(empty result)</p>
          ))}
      </section>
    </div>
  )
}

/** Persisted tool invocation (FR-3, Q1=A): collapsed card with a one-line
 * summary header; expands to Arguments + Result. Also renders orphan tool
 * results (no matching call — args null). */
function ToolCallCard(props: {
  name: string
  args: string | null
  resultText: string | null
  orphan?: boolean
  testId: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const result = props.resultText !== null ? parseToolResult(props.resultText) : null
  const failed = result?.failed ?? false
  const summary =
    props.args !== null ? redact(argsSummary(props.args)) : props.orphan ? 'unmatched result' : ''
  const hint = result && failed ? redact(failureHint(result)) : ''
  return (
    <div
      data-testid={props.testId}
      className={`overflow-hidden rounded-lg border ${failed ? 'border-bad/50' : 'border-edge'} bg-panel-2`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs hover:bg-panel"
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <StatusIcon state={failed ? 'failed' : result ? 'ok' : 'pending'} />
        <span className="shrink-0 font-medium text-ink">{props.name}</span>
        {summary && <span className="min-w-0 truncate text-ink-dim">{summary}</span>}
        {hint && <span className="ml-auto max-w-[40%] shrink-0 truncate text-bad">{hint}</span>}
      </button>
      {open && <ToolCardBody args={props.args} result={result} />}
    </div>
  )
}

/** Streaming tool invocation (Q3=A): same card shell, header-only — live
 * events carry just a preview and, on completion, success/duration; the full
 * args/result card replaces it after end-of-turn re-hydration (W7). */
function LiveToolCard(props: { tool: LiveToolCall }): ReactNode {
  const { tool } = props
  const state = tool.error === null ? 'running' : tool.error ? 'failed' : 'ok'
  return (
    <div
      data-testid="chat-tool-call"
      data-state={state}
      className={`overflow-hidden rounded-lg border ${state === 'failed' ? 'border-bad/50' : 'border-edge'} bg-panel-2`}
    >
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-xs">
        <StatusIcon state={state} />
        <span className="shrink-0 font-medium text-ink">{tool.tool}</span>
        {tool.preview && <span className="min-w-0 truncate text-ink-dim">{tool.preview}</span>}
        {tool.duration && (
          <span className="ml-auto shrink-0 text-ink-faint">{tool.duration}s</span>
        )}
      </div>
    </div>
  )
}

function TranscriptBlock(props: { item: TranscriptItem }): ReactNode {
  const { item } = props
  const thinkingOpen = loadPrefs().thinkingOpen
  if (item.kind === 'user') {
    return (
      <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-sm whitespace-pre-wrap">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    // Re-hydrated from the persisted turn (W7). Render order follows how the
    // turn actually happened (FR-1): thinking → reply text → tool calls, each
    // call carrying its merged result (FR-2). An assistant tool-call message
    // has empty content — skip the empty bubble.
    return (
      <div className="space-y-2">
        {item.reasoning.trim() && (
          <Collapsible
            summary={<span className="text-xs text-ink-dim">∴ thinking</span>}
            defaultOpen={thinkingOpen}
            testId="chat-thinking-toggle"
          >
            <p className="text-xs whitespace-pre-wrap text-ink-dim">{redact(item.reasoning)}</p>
          </Collapsible>
        )}
        {item.text.trim() && <Markdown text={redact(item.text, DELTA_LIMIT)} />}
        {item.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {item.toolCalls.map((call: TranscriptToolCall, index) => (
              <ToolCallCard
                key={index}
                name={call.name}
                args={call.args}
                resultText={call.result?.text ?? null}
                testId="chat-tool-call"
              />
            ))}
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'tool') {
    // orphan result — its originating call was not found (FR-2 fallback)
    return (
      <ToolCallCard
        name={item.toolName || 'tool'}
        args={null}
        resultText={item.text}
        orphan
        testId="chat-tool-result"
      />
    )
  }
  return (
    <div className="text-xs text-ink-dim">
      [{item.role || 'unknown'}] {redact(item.text, 500)}
    </div>
  )
}

function LiveTurnBlock(props: { turn: LiveTurn; streaming: boolean }): ReactNode {
  const { turn, streaming } = props
  // Q4=B: the sessions stream carries reasoning live (tool.progress{_thinking}),
  // so thinking renders inline in arrival order — same ∴ thinking card the
  // re-hydrated transcript (W7) produces, so nothing jumps when the turn ends.
  if (turnIsEmpty(turn)) return null
  const lastIndex = turn.segments.length - 1
  return (
    <div className="space-y-2" data-testid="chat-live-turn">
      {turn.userText && (
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {turn.userText}
        </div>
      )}
      {/* FR-1: content and tool cards render in event-arrival order — the same
          relative order the re-hydrated history path produces, so nothing jumps
          when the turn ends. Segments only ever append or update in place, so
          index keys are stable. */}
      {turn.segments.map((seg, index) => {
        if (seg.kind === 'tool') return <LiveToolCard key={index} tool={seg.tool} />
        if (seg.kind === 'reasoning')
          return (
            <Collapsible
              key={index}
              summary={<span className="text-xs text-ink-dim">∴ thinking</span>}
              defaultOpen={loadPrefs().thinkingOpen}
              testId="chat-thinking-toggle"
            >
              {/* redact the COALESCED segment: a secret split across deltas has
                  no contiguous run in any single delta, so per-delta redaction
                  misses it — re-redact the assembled text (same as the
                  re-hydrated transcript does) so it never reaches the DOM raw */}
              <p className="text-xs whitespace-pre-wrap text-ink-dim">{redact(seg.text)}</p>
            </Collapsible>
          )
        return (
          <div key={index} className="text-sm">
            <Markdown text={redact(seg.text, DELTA_LIMIT)} />
            {/* cursor rides the trailing text only; a running tool below shows
                its own spinner, so no stray cursor mid-conversation */}
            {streaming && index === lastIndex && (
              <span className="animate-pulse text-accent">▍</span>
            )}
          </div>
        )
      })}
      {turn.notes.map((note, index) => (
        <p
          key={`note-${index}`}
          className="text-xs text-ink-dim italic"
          data-testid="chat-system-note"
        >
          {note}
        </p>
      ))}
    </div>
  )
}
