/** Agent detail (redesign §6.3): hero header (name + live badges + action
 * group) over tabbed content. 202-accepted semantics preserved: buttons only
 * acknowledge the request; the transition arrives via WS, with a 30s REST
 * fallback refetch (S-U4-2). */

import { ArrowLeft, ExternalLink, MessageSquare, Play, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { ConfirmModal } from '../../components/ConfirmModal'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Skeleton } from '../../components/ui/Skeleton'
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
        <Link className="text-accent hover:underline" to="/agents">
          Back to agents
        </Link>
      </p>
    )
  }

  return (
    <div>
      <Link
        to="/agents"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden /> agents
      </Link>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="agent-detail-title">
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            testId="agent-detail-start-button"
            disabled={busy !== null}
            onClick={() => void lifecycle('start')}
          >
            <Play size={13} aria-hidden /> {busy === 'start' ? 'Starting…' : 'Start'}
          </Button>
          <Button
            variant="outline"
            testId="agent-detail-stop-button"
            disabled={busy !== null}
            onClick={() => void lifecycle('stop')}
          >
            <Square size={13} aria-hidden /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
          <Link data-testid="agent-detail-chat-link" to={`/chat/${encodeURIComponent(name)}`}>
            <Button variant="outline">
              <MessageSquare size={13} aria-hidden /> Chat
            </Button>
          </Link>
          <a
            data-testid="agent-detail-dashboard-link"
            href="http://127.0.0.1:9119"
            target="_blank"
            rel="noreferrer"
            title="hermes native dashboard (start it with `hermes dashboard`)"
          >
            <Button variant="ghost">
              hermes <ExternalLink size={12} aria-hidden />
            </Button>
          </a>
          <Button
            variant="dangerGhost"
            testId="agent-detail-remove-button"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 size={13} aria-hidden /> Remove
          </Button>
        </div>
      </div>

      <div className="mb-4 flex gap-1 border-b border-edge">
        {(['overview', 'logs', 'settings'] as const).map((t) => (
          <button
            key={t}
            data-testid={`agent-detail-tab-${t}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors ${
              tab === t
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-ink-dim hover:text-ink'
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {removeJobId && (
        <div className="mb-4">
          <JobProgressCard
            jobId={removeJobId}
            onDone={() => {
              void navigate('/agents')
            }}
          />
        </div>
      )}

      {tab === 'overview' && !(record && status) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      )}

      {tab === 'overview' && record && status && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Runtime" />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Info label="image" value={record.spec.docker_image} wide />
              <Info label="network" value={record.spec.network_mode} />
              <Info label="approvals" value={record.spec.approvals_mode} />
              <Info label="cpu" value={record.spec.cpu === null ? '—' : String(record.spec.cpu)} />
              <Info
                label="memory"
                value={record.spec.memory_mb === null ? '—' : `${record.spec.memory_mb} MB`}
              />
            </dl>
          </Card>
          <Card>
            <CardHeader title="Placement" />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Info label="api_server port" value={String(record.api_port)} />
              <Info label="profile" value={record.profile_name} />
              <Info label="workspace" value={record.workspace_dir} wide />
              <Info label="created" value={record.created_at} wide />
            </dl>
          </Card>
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
    <div className={props.wide ? 'col-span-2' : ''}>
      <dt className="text-xs tracking-wide text-ink-faint uppercase">{props.label}</dt>
      <dd className="mt-0.5 font-mono text-xs break-all text-ink">{props.value}</dd>
    </div>
  )
}
