/** Agent detail: overview (status card + lifecycle actions + dashboard link),
 * logs tab (Q8=A), settings tab (Q4=A). 202-accepted semantics: buttons only
 * acknowledge the request; the transition arrives via WS, with a 30s REST
 * fallback refetch (S-U4-2). */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { ConfirmModal } from '../../components/ConfirmModal'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import type { AgentRecord, AgentStatus } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { LogsTab } from './LogsTab'
import { SettingsTab } from './SettingsTab'

type Tab = 'overview' | 'logs' | 'settings'

export function AgentDetailPage(): ReactNode {
  const params = useParams<{ name: string }>()
  const name = params.name ?? ''
  const { client, state, toast } = useApp()
  const navigate = useNavigate()

  const [record, setRecord] = useState<AgentRecord | null>(null)
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [removeJobId, setRemoveJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const [notFound, setNotFound] = useState(false)
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refetch = useCallback(async () => {
    try {
      const detail = await client.getAgent(name)
      setRecord(detail.record)
      setStatus(detail.status)
      setNotFound(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setNotFound(true)
    }
  }, [client, name])

  useEffect(() => {
    void refetch()
    return () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current)
    }
  }, [refetch])

  // live overlay clears busy once the process transition lands (WPT-7: no optimism)
  const live = state.live.agents[name]
  useEffect(() => {
    if (busy && live?.process) setBusy(null)
  }, [busy, live?.process])

  async function lifecycle(op: 'start' | 'stop'): Promise<void> {
    setBusy(op)
    try {
      await (op === 'start' ? client.startAgent(name) : client.stopAgent(name))
      toast('info', `${op} requested for ${name}`)
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current)
      fallbackTimer.current = setTimeout(() => {
        setBusy(null)
        void refetch()
      }, 30_000)
    } catch (error) {
      setBusy(null)
      toast('error', error instanceof ApiError ? error.message : `${op} failed`)
    }
  }

  async function remove(typed: string): Promise<void> {
    setConfirmOpen(false)
    try {
      const { job_id } = await client.removeAgent(name, typed)
      setRemoveJobId(job_id)
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'remove failed')
    }
  }

  if (notFound) {
    return (
      <p className="text-sm text-ink-dim">
        Agent not found.{' '}
        <Link className="text-accent-strong hover:underline" to="/agents">
          Back to agents
        </Link>
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/agents" className="text-sm text-ink-dim hover:text-ink">
          ← agents
        </Link>
        <h1 className="text-xl font-semibold" data-testid="agent-detail-title">
          {name}
        </h1>
        {status && (
          <StatusBadge
            value={live?.process ?? status.process}
            testId="agent-detail-process-badge"
          />
        )}
        {status && (
          <StatusBadge value={live?.health ?? status.health} testId="agent-detail-health-badge" />
        )}
      </div>

      <div className="flex gap-1 border-b border-edge">
        {(['overview', 'logs', 'settings'] as const).map((t) => (
          <button
            key={t}
            data-testid={`agent-detail-tab-${t}`}
            className={`px-3 py-1.5 text-sm ${
              tab === t
                ? 'border-b-2 border-accent-strong font-medium text-accent-strong'
                : 'text-ink-dim hover:text-ink'
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {removeJobId && (
        <JobProgressCard
          jobId={removeJobId}
          onDone={() => {
            void navigate('/agents')
          }}
        />
      )}

      {tab === 'overview' && record && status && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              data-testid="agent-detail-start-button"
              disabled={busy !== null}
              onClick={() => void lifecycle('start')}
              className="rounded bg-accent-strong px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy === 'start' ? 'Starting…' : 'Start'}
            </button>
            <button
              data-testid="agent-detail-stop-button"
              disabled={busy !== null}
              onClick={() => void lifecycle('stop')}
              className="rounded border border-edge px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
            <Link
              data-testid="agent-detail-chat-link"
              to={`/chat/${encodeURIComponent(name)}`}
              className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-panel"
            >
              Chat
            </Link>
            <a
              data-testid="agent-detail-dashboard-link"
              href="http://127.0.0.1:9119"
              target="_blank"
              rel="noreferrer"
              className="rounded border border-edge px-3 py-1.5 text-sm text-ink-dim hover:text-ink"
              title="hermes native dashboard (start it with `hermes dashboard`)"
            >
              hermes dashboard ↗
            </a>
            <button
              data-testid="agent-detail-remove-button"
              onClick={() => setConfirmOpen(true)}
              className="ml-auto rounded border border-bad/40 px-3 py-1.5 text-sm text-bad hover:bg-bad/10"
            >
              Remove
            </button>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded border border-edge bg-panel p-4 text-sm sm:grid-cols-3">
            <Info label="image" value={record.spec.docker_image} />
            <Info label="network" value={record.spec.network_mode} />
            <Info label="approvals" value={record.spec.approvals_mode} />
            <Info label="api_server port" value={String(record.api_port)} />
            <Info label="cpu" value={record.spec.cpu === null ? '—' : String(record.spec.cpu)} />
            <Info
              label="memory"
              value={record.spec.memory_mb === null ? '—' : `${record.spec.memory_mb} MB`}
            />
            <Info label="workspace" value={record.workspace_dir} wide />
            <Info label="created" value={record.created_at} wide />
          </dl>
        </div>
      )}

      {tab === 'logs' && <LogsTab agent={name} />}
      {tab === 'settings' && <SettingsTab agent={name} />}

      <ConfirmModal
        open={confirmOpen}
        title={`Remove agent "${name}"`}
        body={
          <>
            This unregisters the service, stops the gateway and deletes the profile.{' '}
            <strong>The workspace directory is preserved</strong>
            {record ? ` (${record.workspace_dir})` : ''} — remove it manually if you no longer need
            the artifacts.
          </>
        }
        confirmLabel="Remove agent"
        typedName={name}
        destructive
        onConfirm={(typed) => void remove(typed)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}

function Info(props: { label: string; value: string; wide?: boolean }): ReactNode {
  return (
    <div className={props.wide ? 'col-span-2 sm:col-span-3' : ''}>
      <dt className="text-xs uppercase tracking-wide text-ink-dim">{props.label}</dt>
      <dd className="break-all font-mono text-xs">{props.value}</dd>
    </div>
  )
}
