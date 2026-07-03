/** Conversation view (S-U4-4, F6) — redesigned (§6.4, Q4=A): full-height
 * three-pane layout (sessions | conversation | meta rail), markdown-rendered
 * assistant turns, tool-call chips.
 *
 * W7 single source of truth: entering, switching or finishing a turn always
 * re-hydrates the transcript from GET api/sessions/{id}/messages — local
 * streaming buffers are render-only and are discarded on re-hydration.
 * The turn uses the U3-verified /v1/runs composition; the run state machine
 * is the pure lib/chatMachine (PU4-2) and this component merely executes the
 * actions it returns. */

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
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
  startRun,
  stopRun,
  streamRunEvents,
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
  historyFromMessages,
  transcriptFromMessages,
  type TranscriptItem,
  type TranscriptToolCall,
} from '../../lib/transcript'
import type { SessionInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { loadPrefs } from '../../state/prefs'

const DELTA_LIMIT = 1_000_000

const fmt = (n: number): string => n.toLocaleString('en-US')

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** FR-4: grow the composer with its content up to ~8 lines (matches the
 * `max-h-52` cap = 208px), after which it scrolls internally. */
const COMPOSER_MAX_HEIGHT_PX = 208

function autoGrowComposer(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
}

interface ToolCall {
  tool: string
  preview: string
  error: boolean | null
  duration: string
}

interface LiveTurn {
  userText: string
  assistantText: string
  tools: ToolCall[]
  notes: string[]
}

const EMPTY_TURN: LiveTurn = {
  userText: '',
  assistantText: '',
  tools: [],
  notes: [],
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
    void refetchAgents() // meta rail needs the agent's live status
  }, [refetchAgents])

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
      const raw = await fetchMessages(client, agent, sessionId) // W7 hydration for history
      const runId = await startRun(client, agent, {
        input: text,
        session_id: sessionId,
        conversation_history: historyFromMessages(raw),
      })
      runIdRef.current = runId
      await consumeStream(runId)
    } catch (error) {
      pushNote(
        error instanceof ApiError
          ? `turn failed: ${error.message}`
          : 'connection lost — the session is preserved',
      )
    } finally {
      setMachine('idle')
      runIdRef.current = null
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
    setTurn((t) => ({ ...t, notes: [...t.notes, note] }))
  }

  async function consumeStream(runId: string): Promise<void> {
    await streamRunEvents(client, agent, runId, (event) => {
      const payload = event.payload
      switch (event.kind) {
        case 'message.delta': {
          const delta = typeof payload['delta'] === 'string' ? payload['delta'] : ''
          setTurn((t) => ({ ...t, assistantText: t.assistantText + redact(delta, DELTA_LIMIT) }))
          break
        }
        case 'reasoning.available': {
          // Despite the name, hermes fills this event with the assistant REPLY
          // text (conversation_loop relay), NOT the model's chain-of-thought.
          // The real reasoning is only persisted to the session store, so it
          // surfaces after the turn via W7 re-hydration — it cannot stream
          // live. Treat this purely as a reply fallback for providers that emit
          // no message.delta; the dedupe guard avoids echoing a streamed reply.
          const text = redact(String(payload['text'] ?? ''), DELTA_LIMIT)
          setTurn((t) =>
            text.trim() && !t.assistantText.trim() ? { ...t, assistantText: text } : t,
          )
          break
        }
        case 'tool.started': {
          const preview = redact(String(payload['preview'] ?? '')).slice(0, 120)
          const tool = String(payload['tool'] ?? '?')
          setTurn((t) => ({
            ...t,
            tools: [...t.tools, { tool, preview, error: null, duration: '' }],
          }))
          break
        }
        case 'tool.completed': {
          const tool = String(payload['tool'] ?? '?')
          const failed = Boolean(payload['error'])
          const duration = String(payload['duration'] ?? '?')
          setTurn((t) => {
            const tools = [...t.tools]
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i]!.tool === tool && tools[i]!.error === null) {
                tools[i] = { ...tools[i]!, error: failed, duration }
                return { ...t, tools }
              }
            }
            return { ...t, tools: [...tools, { tool, preview: '', error: failed, duration }] }
          })
          break
        }
        case 'approval.request': {
          const [next, action] = transition(machineRef.current, 'approval_request')
          setMachine(next)
          if (action === 'prompt_approval') {
            const summary = redact(
              String(
                payload['preview'] ?? payload['command'] ?? payload['tool'] ?? 'tool execution',
              ),
            ).slice(0, 200)
            setApproval({ runId, summary })
          } else if (action === 'auto_deny') {
            void sendApproval(client, agent, runId, 'deny')
          }
          break
        }
        case 'run.completed': {
          const output = String(payload['output'] ?? '')
          setTurn((t) =>
            output && !t.assistantText.trim()
              ? { ...t, assistantText: redact(output, DELTA_LIMIT) } // no deltas streamed
              : t,
          )
          break
        }
        case 'run.failed':
          pushNote(`run failed: ${redact(String(payload['error'] ?? 'unknown'))}`)
          break
        case 'run.cancelled':
          pushNote('turn stopped')
          break
        default:
          break // unknown kinds ignored (forward compatibility)
      }
    })
    const [next] = transition(machineRef.current, 'stream_end')
    setMachine(next)
  }

  function interrupt(): void {
    const runId = runIdRef.current
    const [next, action] = transition(machineRef.current, 'interrupt')
    setMachine(next)
    if (action === 'send_stop' && runId) {
      pushNote('stopping current turn — session preserved')
      stopRun(client, agent, runId).catch((error: unknown) => {
        toast('warn', error instanceof ApiError ? `stop failed: ${error.message}` : 'stop failed')
      })
    } else if (action === 'auto_deny' && runId) {
      setApproval(null)
      void sendApproval(client, agent, runId, 'deny')
    }
  }

  function answerApproval(choice: ApprovalChoice): void {
    if (!approval) return
    void sendApproval(client, agent, approval.runId, choice)
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
        <div className="border-b border-edge p-3">
          <Button
            variant="gradient"
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
                  {session.title || session.id}
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
      </aside>

      {/* ── conversation ──────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-edge bg-panel px-6 py-3">
          <div className="min-w-0 text-sm text-ink-dim">
            chat with{' '}
            <Link
              to={`/agents/${encodeURIComponent(agent)}`}
              className="font-semibold text-ink hover:text-accent"
            >
              {agent}
            </Link>
            {activeId && (
              <span className="ml-2 hidden font-mono text-xs text-ink-faint md:inline">
                session {activeId}
              </span>
            )}
          </div>
          <SessionUsage session={activeSession} />
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

      {/* ── meta rail (xl+) ───────────────────────────────────────────── */}
      <aside className="hidden w-64 shrink-0 space-y-5 overflow-y-auto border-l border-edge bg-panel p-4 2xl:block">
        <div>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">Agent</h3>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge value={agentLive?.process ?? agentListed?.process ?? 'unknown'} />
            <StatusBadge value={agentLive?.health ?? agentListed?.health ?? 'unknown'} />
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">
            Session usage
          </h3>
          {activeSession ? (
            <dl className="space-y-1.5 text-sm">
              <UsageRowItem label="input" value={activeSession.input_tokens} />
              <UsageRowItem label="cache read" value={activeSession.cache_read_tokens} />
              <UsageRowItem label="output" value={activeSession.output_tokens} />
              {activeSession.estimated_cost_usd != null && activeSession.estimated_cost_usd > 0 && (
                <div className="flex justify-between border-t border-edge pt-1.5">
                  <dt className="text-ink-dim">est. cost</dt>
                  <dd className="font-mono text-xs">
                    ${activeSession.estimated_cost_usd.toFixed(4)}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-xs text-ink-faint">no active session</p>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">
            Sessions
          </h3>
          <p className="text-sm text-ink-dim">{sessions.length} total</p>
        </div>
      </aside>

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

function UsageRowItem(props: { label: string; value: number | null | undefined }): ReactNode {
  return (
    <div className="flex justify-between">
      <dt className="text-ink-dim">{props.label}</dt>
      <dd className="font-mono text-xs tabular-nums">{fmt(props.value ?? 0)}</dd>
    </div>
  )
}

/** Compact session-usage readout in the conversation header — hermes-native
 * cumulative counts (cache read split out). Updates whenever the session list
 * refreshes (i.e. after each turn). */
function SessionUsage(props: { session: SessionInfo | null }): ReactNode {
  const { session } = props
  const input = session?.input_tokens ?? null
  const output = session?.output_tokens ?? null
  const cacheRead = session?.cache_read_tokens ?? 0
  const cost = session?.estimated_cost_usd ?? null
  if (input == null && output == null) {
    return (
      <span className="shrink-0 text-xs text-ink-faint" data-testid="chat-session-usage">
        session usage —
      </span>
    )
  }
  return (
    <span className="shrink-0 text-xs text-ink-dim" data-testid="chat-session-usage">
      session · in {fmt(input ?? 0)}
      {cacheRead > 0 && <> (cache {fmt(cacheRead)})</>} / out {fmt(output ?? 0)}
      {cost != null && cost > 0 && <> · ${cost.toFixed(4)}</>}
    </span>
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
function LiveToolCard(props: { tool: ToolCall }): ReactNode {
  const { tool } = props
  const state = tool.error === null ? 'running' : tool.error ? 'failed' : 'ok'
  return (
    <div
      data-testid="chat-tool-call"
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
  // No thinking block live: hermes does not stream the model's chain-of-thought
  // (only message.delta / tool.* / a reply relay). Reasoning is persisted and
  // shown once the turn completes and the transcript re-hydrates (W7).
  const empty =
    !turn.userText && !turn.assistantText && turn.tools.length === 0 && turn.notes.length === 0
  if (empty) return null
  return (
    <div className="space-y-2" data-testid="chat-live-turn">
      {turn.userText && (
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {turn.userText}
        </div>
      )}
      {turn.tools.length > 0 && (
        <div className="space-y-1.5">
          {turn.tools.map((tool, index) => (
            <LiveToolCard key={index} tool={tool} />
          ))}
        </div>
      )}
      {turn.assistantText && (
        <div className="text-sm">
          <Markdown text={turn.assistantText} />
          {streaming && <span className="animate-pulse text-accent">▍</span>}
        </div>
      )}
      {turn.notes.map((note, index) => (
        <p key={index} className="text-xs text-ink-dim italic" data-testid="chat-system-note">
          {note}
        </p>
      ))}
    </div>
  )
}
