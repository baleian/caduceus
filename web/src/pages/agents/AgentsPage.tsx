/** Agents (S-U4-1, redesign §6.2 Q3=B): searchable card grid with live badges
 * from the reducer overlay and per-card quick actions; the create form moved
 * into a right-hand Drawer (P5) keeping the same validation and testids. */

import { Box, Container, Cpu, MessageSquare, Play, Plus, Square } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { Collapsible } from '../../components/Collapsible'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Drawer } from '../../components/ui/Drawer'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field, INPUT_CLASS, INPUT_MONO_CLASS } from '../../components/ui/Field'
import { PageHeader } from '../../components/ui/PageHeader'
import { SearchInput } from '../../components/ui/SearchInput'
import { validateAgentForm, type AgentFormValues, type FieldErrors } from '../../lib/forms'
import type { AgentStatus } from '../../lib/types'
import { useApp } from '../../state/AppStore'

const EMPTY_FORM: AgentFormValues = {
  name: '',
  docker_image: '',
  network_mode: 'host',
  cpu: '',
  memory_mb: '',
  persona: '',
}

export function AgentsPage(): ReactNode {
  const { state, refetchAgents } = useApp()
  const [creating, setCreating] = useState(false)
  const [jobIds, setJobIds] = useState<string[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refetchAgents()
  }, [refetchAgents])

  const visible = state.agents.filter((a) =>
    a.name.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <div>
      <PageHeader
        title="Agents"
        description="managed hermes agents behind the gateway"
        actions={
          <>
            <SearchInput value={query} onChange={setQuery} placeholder="Filter by name…" />
            <Button
              variant="gradient"
              testId="agents-create-toggle-button"
              onClick={() => setCreating((v) => !v)}
            >
              <Plus size={14} aria-hidden /> New agent
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        {jobIds.map((jobId) => (
          <JobProgressCard key={jobId} jobId={jobId} />
        ))}

        {state.agents.length === 0 ? (
          <div data-testid="agents-empty-note">
            <EmptyState
              icon={Box}
              title="No agents yet"
              description="Create one to get started — the daemon provisions the container, gateway and profile for you."
              action={
                <Button variant="gradient" onClick={() => setCreating(true)}>
                  <Plus size={14} aria-hidden /> New agent
                </Button>
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-dashed border-edge-strong p-6 text-center text-sm text-ink-dim">
            no agents match “{query}”
          </p>
        ) : (
          <div
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
            data-testid="agents-table"
          >
            {visible.map((agent) => (
              <AgentCard key={agent.name} agent={agent} />
            ))}
          </div>
        )}
      </div>

      <Drawer open={creating} title="New agent" onClose={() => setCreating(false)}>
        <CreateAgentPanel
          onJob={(jobId) => setJobIds((ids) => [...ids, jobId])}
          onClose={() => setCreating(false)}
        />
      </Drawer>
    </div>
  )
}

function AgentCard(props: { agent: AgentStatus }): ReactNode {
  const { agent } = props
  const { client, state, toast } = useApp()
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const live = state.live.agents[agent.name]
  const process = live?.process ?? agent.process
  const running = process === 'running'

  // live overlay clears busy once the transition lands (WPT-7: no optimism)
  useEffect(() => {
    if (busy && live?.process) setBusy(null)
  }, [busy, live?.process])

  async function lifecycle(op: 'start' | 'stop'): Promise<void> {
    setBusy(op)
    try {
      await (op === 'start' ? client.startAgent(agent.name) : client.stopAgent(agent.name))
      toast('info', `${op} requested for ${agent.name}`)
    } catch (error) {
      setBusy(null)
      toast('error', error instanceof ApiError ? error.message : `${op} failed`)
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <Link
          data-testid={`agents-row-${agent.name}-link`}
          className="min-w-0 truncate text-base font-semibold hover:text-accent"
          to={`/agents/${encodeURIComponent(agent.name)}`}
        >
          {agent.name}
        </Link>
        <StatusBadge value={process} testId={`agents-row-${agent.name}-process-badge`} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">
        <span className="inline-flex items-center gap-1">
          <Cpu size={12} aria-hidden /> {agent.health}
        </span>
        <span className="inline-flex items-center gap-1">
          <Container size={12} aria-hidden /> {agent.container}
        </span>
        <span className="text-ink-faint">desired: {agent.desired_state}</span>
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-edge pt-3">
        {running ? (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => void lifecycle('stop')}
          >
            <Square size={12} aria-hidden /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="xs"
            disabled={busy !== null}
            onClick={() => void lifecycle('start')}
          >
            <Play size={12} aria-hidden /> {busy === 'start' ? 'Starting…' : 'Start'}
          </Button>
        )}
        <Link to={`/chat/${encodeURIComponent(agent.name)}`}>
          <Button variant="ghost" size="xs">
            <MessageSquare size={12} aria-hidden /> Chat
          </Button>
        </Link>
      </div>
    </Card>
  )
}

function CreateAgentPanel(props: {
  onJob: (jobId: string) => void
  onClose: () => void
}): ReactNode {
  const { client, toast } = useApp()
  const [values, setValues] = useState<AgentFormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)

  function set<K extends keyof AgentFormValues>(key: K, value: string): void {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function submit(): Promise<void> {
    const found = validateAgentForm(values)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setSubmitting(true)
    try {
      const spec: Record<string, unknown> = { name: values.name.trim() }
      if (values.docker_image.trim()) spec['docker_image'] = values.docker_image.trim()
      if (values.network_mode !== 'host') spec['network_mode'] = values.network_mode
      if (values.cpu.trim()) spec['cpu'] = Number(values.cpu)
      if (values.memory_mb.trim()) spec['memory_mb'] = Number(values.memory_mb)
      if (values.persona.trim()) spec['persona'] = values.persona
      const { job_id } = await client.createAgent(spec)
      props.onJob(job_id)
      props.onClose()
    } catch (error) {
      // the server is authoritative (W4) — surface its message on the name field
      const message = error instanceof ApiError ? error.message : 'create failed'
      setErrors({ name: message })
      toast('error', message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      data-testid="agent-create-form"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Field label="name" error={errors.name}>
        <input
          data-testid="agent-create-name-input"
          className={INPUT_CLASS}
          value={values.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="my-agent"
          autoFocus
        />
      </Field>

      <Collapsible
        summary={<span className="text-sm text-ink-dim">Advanced options</span>}
        testId="agent-create-advanced-toggle"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="docker image" hint="blank = server default" error={errors.docker_image}>
            <input
              data-testid="agent-create-image-input"
              className={INPUT_MONO_CLASS}
              value={values.docker_image}
              onChange={(e) => set('docker_image', e.target.value)}
            />
          </Field>
          <Field label="network" error={undefined}>
            <select
              data-testid="agent-create-network-select"
              className={INPUT_CLASS}
              value={values.network_mode}
              onChange={(e) => set('network_mode', e.target.value)}
            >
              <option value="host">host (default)</option>
              <option value="bridge_hostgw">bridge + host gateway</option>
              <option value="none">none</option>
            </select>
          </Field>
          <Field label="cpu" error={errors.cpu}>
            <input
              data-testid="agent-create-cpu-input"
              className={INPUT_CLASS}
              value={values.cpu}
              onChange={(e) => set('cpu', e.target.value)}
              placeholder="e.g. 2"
            />
          </Field>
          <Field label="memory (MB)" error={errors.memory_mb}>
            <input
              data-testid="agent-create-memory-input"
              className={INPUT_CLASS}
              value={values.memory_mb}
              onChange={(e) => set('memory_mb', e.target.value)}
              placeholder="≥256"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="persona (SOUL.md seed)" error={errors.persona}>
              <textarea
                data-testid="agent-create-persona-input"
                rows={5}
                className={INPUT_MONO_CLASS}
                value={values.persona}
                onChange={(e) => set('persona', e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Collapsible>

      <div className="flex justify-end">
        <Button
          variant="gradient"
          size="md"
          testId="agent-create-submit-button"
          type="submit"
          disabled={submitting}
        >
          {submitting ? 'Creating…' : 'Create agent'}
        </Button>
      </div>
    </form>
  )
}
