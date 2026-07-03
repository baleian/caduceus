/** Conversation view (S-U4-4, F6).
 *
 * W7 single source of truth: entering, switching or finishing a turn always
 * re-hydrates the transcript from GET api/sessions/{id}/messages — local
 * streaming buffers are render-only and are discarded on re-hydration.
 * The turn uses the U3-verified /v1/runs composition; the run state machine
 * is the pure lib/chatMachine (PU4-2) and this component merely executes the
 * actions it returns.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useBlocker, useParams } from 'react-router-dom'

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
import {
  APPROVAL_CHOICES,
  transition,
  type ApprovalChoice,
  type ChatState,
} from '../../lib/chatMachine'
import { redact } from '../../lib/redact'
import {
  historyFromMessages,
  toolFailureSummary,
  transcriptFromMessages,
  type TranscriptItem,
} from '../../lib/transcript'
import type { SessionInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { loadPrefs } from '../../state/prefs'

const DELTA_LIMIT = 1_000_000

const fmt = (n: number): string => n.toLocaleString('en-US')

interface ToolCall {
  tool: string
  preview: string
  error: boolean | null
  duration: string
}

interface LiveTurn {
  userText: string
  assistantText: string
  reasoning: string[]
  tools: ToolCall[]
  notes: string[]
}

const EMPTY_TURN: LiveTurn = {
  userText: '',
  assistantText: '',
  reasoning: [],
  tools: [],
  notes: [],
}

export function ChatView(): ReactNode {
  const params = useParams<{ name: string }>()
  const agent = params.name ?? ''
  const { client, toast } = useApp()

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
  const bottomRef = useRef<HTMLDivElement>(null)

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
    async (sessionId: string) => {
      // W7: server store is the single source — discard any local transcript
      const messages = await fetchMessages(client, agent, sessionId)
      setTranscript(transcriptFromMessages(messages))
      setTurn(EMPTY_TURN)
      queueMicrotask(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
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
      // re-hydrate so tool results/failure details replace the live buffers
      if (sessionId) {
        try {
          await hydrate(sessionId)
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
          // hermes relays the reply text through this event; only render text
          // the delta stream did not carry (U3 dedupe rule)
          const text = String(payload['text'] ?? '').trim()
          setTurn((t) =>
            text && !t.assistantText.includes(text)
              ? { ...t, reasoning: [...t.reasoning, redact(text)] }
              : t,
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
          setTranscript([])
        }
      }
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'delete failed')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex gap-4" data-testid="chat-view">
      <aside className="w-56 shrink-0 space-y-2">
        <button
          data-testid="chat-new-session-button"
          className="w-full rounded bg-accent-strong px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          onClick={() => void newSession()}
        >
          New session
        </button>
        <ul className="space-y-1" data-testid="chat-session-list">
          {sessions.map((session) => (
            <li key={session.id} className="group">
              <button
                data-testid={`chat-session-${session.id}-button`}
                onClick={() => void selectSession(session.id)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  session.id === activeId ? 'bg-accent/15 text-accent-strong' : 'hover:bg-panel'
                }`}
              >
                <span className="block truncate">{session.title || session.id}</span>
                <span className="block truncate text-xs text-ink-dim">
                  {session.last_active ?? session.started_at ?? ''}
                </span>
              </button>
              <div className="hidden justify-end gap-2 px-2 text-xs text-ink-dim group-hover:flex">
                <button
                  data-testid={`chat-session-${session.id}-rename-button`}
                  className="hover:text-ink"
                  onClick={() => setRenameTarget({ id: session.id, title: session.title ?? '' })}
                >
                  rename
                </button>
                <button
                  data-testid={`chat-session-${session.id}-delete-button`}
                  className="hover:text-bad"
                  onClick={() => setDeleteTarget(session)}
                >
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[70vh] flex-1 flex-col rounded border border-edge bg-panel">
        <header className="border-b border-edge px-4 py-2 text-sm text-ink-dim">
          <div className="flex items-center justify-between gap-3">
            <div>
              chat with <span className="font-medium text-ink">{agent}</span>
              {activeId && <span className="ml-2 font-mono text-xs">session {activeId}</span>}
            </div>
            <SessionUsage session={activeSession} />
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4" data-testid="chat-transcript">
          {loadError && <p className="text-sm text-bad">{loadError}</p>}
          {!loadError && !activeId && (
            <p className="text-sm text-ink-dim">
              No sessions yet — just type below; a session is created automatically.
            </p>
          )}
          {transcript.map((item, index) => (
            <TranscriptBlock key={index} item={item} />
          ))}
          <LiveTurnBlock turn={turn} streaming={streaming} />
          <div ref={bottomRef} />
        </div>

        {approval && (
          <div
            data-testid="chat-approval-card"
            className="mx-4 mb-2 rounded border border-warn/60 bg-warn/10 p-3 text-sm"
          >
            <p className="mb-2 font-medium">⚠ approval requested: {approval.summary}</p>
            <div className="flex gap-2">
              {APPROVAL_CHOICES.map((choice) => (
                <button
                  key={choice}
                  data-testid={`chat-approval-${choice}-button`}
                  className={`rounded px-3 py-1 text-xs font-medium ${
                    choice === 'deny'
                      ? 'border border-edge text-ink-dim hover:text-ink'
                      : 'bg-accent-strong text-white hover:opacity-90'
                  }`}
                  onClick={() => answerApproval(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className="flex gap-2 border-t border-edge p-3">
          <textarea
            data-testid="chat-composer-input"
            rows={2}
            className="flex-1 resize-none rounded border border-edge bg-surface px-3 py-2 text-sm"
            placeholder={
              streaming ? 'turn in progress…' : 'message (Enter to send, Shift+Enter for newline)'
            }
            value={input}
            disabled={streaming}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {streaming ? (
            <button
              data-testid="chat-stop-button"
              disabled={machineUi === 'stopping'}
              className="rounded bg-bad px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              onClick={interrupt}
            >
              {machineUi === 'stopping' ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              data-testid="chat-send-button"
              disabled={!input.trim()}
              className="rounded bg-accent-strong px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              onClick={() => void submit()}
            >
              Send
            </button>
          )}
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
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
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

/** Fixed session-usage readout — hermes-native cumulative counts for the active
 * session (cache read split out). Hidden until a session with usage exists;
 * updates whenever the session list refreshes (i.e. after each turn). */
function SessionUsage(props: { session: SessionInfo | null }): ReactNode {
  const { session } = props
  const input = session?.input_tokens ?? null
  const output = session?.output_tokens ?? null
  const cacheRead = session?.cache_read_tokens ?? 0
  const cost = session?.estimated_cost_usd ?? null
  if (input == null && output == null) {
    return (
      <span className="text-xs text-ink-dim" data-testid="chat-session-usage">
        session usage —
      </span>
    )
  }
  return (
    <span className="text-xs text-ink-dim" data-testid="chat-session-usage">
      session · in {fmt(input ?? 0)}
      {cacheRead > 0 && <> (cache {fmt(cacheRead)})</>} / out {fmt(output ?? 0)}
      {cost != null && cost > 0 && <> · ${cost.toFixed(4)}</>}
    </span>
  )
}

function TranscriptBlock(props: { item: TranscriptItem }): ReactNode {
  const { item } = props
  if (item.kind === 'user') {
    return (
      <div className="ml-auto max-w-[80%] rounded-lg bg-accent/15 px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="max-w-[85%] rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-wrap">
        {redact(item.text, DELTA_LIMIT)}
      </div>
    )
  }
  if (item.kind === 'tool') {
    return (
      <Collapsible summary={<span className="font-mono text-xs text-ink-dim">⚙ tool result</span>}>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-ink-dim">
          {toolFailureSummary(item.text, 2000) || '(empty result)'}
        </pre>
      </Collapsible>
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
  const thinkingOpen = loadPrefs().thinkingOpen
  const empty =
    !turn.userText &&
    !turn.assistantText &&
    turn.reasoning.length === 0 &&
    turn.tools.length === 0 &&
    turn.notes.length === 0
  if (empty) return null
  return (
    <div className="space-y-2" data-testid="chat-live-turn">
      {turn.userText && (
        <div className="ml-auto max-w-[80%] rounded-lg bg-accent/15 px-3 py-2 text-sm whitespace-pre-wrap">
          {turn.userText}
        </div>
      )}
      {turn.reasoning.length > 0 && (
        <Collapsible
          summary={<span className="text-xs text-ink-dim">∴ thinking</span>}
          defaultOpen={thinkingOpen}
          testId="chat-thinking-toggle"
        >
          <div className="space-y-1 text-xs text-ink-dim">
            {turn.reasoning.map((text, index) => (
              <p key={index} className="whitespace-pre-wrap">
                {text}
              </p>
            ))}
          </div>
        </Collapsible>
      )}
      {turn.tools.map((tool, index) => (
        <div key={index} className="font-mono text-xs text-ink-dim" data-testid="chat-tool-call">
          <span
            className={tool.error === true ? 'text-bad' : tool.error === false ? 'text-ok' : ''}
          >
            {tool.error === null ? '⚙' : tool.error ? '✗' : '✓'}
          </span>{' '}
          {tool.tool} {tool.preview}
          {tool.duration && ` (${tool.duration}s)`}
        </div>
      ))}
      {turn.assistantText && (
        <div className="max-w-[85%] rounded-lg bg-surface px-3 py-2 text-sm whitespace-pre-wrap">
          {turn.assistantText}
          {streaming && <span className="animate-pulse">▍</span>}
        </div>
      )}
      {turn.notes.map((note, index) => (
        <p key={index} className="text-xs italic text-ink-dim" data-testid="chat-system-note">
          {note}
        </p>
      ))}
    </div>
  )
}
