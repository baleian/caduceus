/** Agents list (S-U4-1): live badges from the reducer overlay, single-form
 * create panel with advanced collapse (Q3=A), inline job progress. */

import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { Collapsible } from '../../components/Collapsible'
import { JobProgressCard } from '../../components/JobProgressCard'
import { StatusBadge } from '../../components/StatusBadge'
import { validateAgentForm, type AgentFormValues, type FieldErrors } from '../../lib/forms'
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
  const { refetchAgents } = useApp()
  const [creating, setCreating] = useState(false)
  const [jobIds, setJobIds] = useState<string[]>([])

  useEffect(() => {
    void refetchAgents()
  }, [refetchAgents])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents</h1>
        <button
          data-testid="agents-create-toggle-button"
          className="rounded bg-accent-strong px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? 'Close' : 'New agent'}
        </button>
      </div>

      {creating && (
        <CreateAgentPanel
          onJob={(jobId) => setJobIds((ids) => [...ids, jobId])}
          onClose={() => setCreating(false)}
        />
      )}

      {jobIds.map((jobId) => (
        <JobProgressCard key={jobId} jobId={jobId} />
      ))}

      <AgentTable />
    </div>
  )
}

function AgentTable(): ReactNode {
  const { state } = useApp()
  if (state.agents.length === 0) {
    return (
      <p
        data-testid="agents-empty-note"
        className="rounded border border-dashed border-edge p-6 text-center text-sm text-ink-dim"
      >
        No agents yet — create one to get started.
      </p>
    )
  }
  return (
    <table className="w-full border-collapse text-sm" data-testid="agents-table">
      <thead>
        <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-ink-dim">
          <th className="px-2 py-2">name</th>
          <th className="px-2 py-2">desired</th>
          <th className="px-2 py-2">process</th>
          <th className="px-2 py-2">health</th>
          <th className="px-2 py-2">container</th>
        </tr>
      </thead>
      <tbody>
        {state.agents.map((agent) => {
          const live = state.live.agents[agent.name]
          return (
            <tr key={agent.name} className="border-b border-edge/60 hover:bg-panel">
              <td className="px-2 py-2">
                <Link
                  data-testid={`agents-row-${agent.name}-link`}
                  className="font-medium text-accent-strong hover:underline"
                  to={`/agents/${encodeURIComponent(agent.name)}`}
                >
                  {agent.name}
                </Link>
              </td>
              <td className="px-2 py-2">{agent.desired_state}</td>
              <td className="px-2 py-2">
                <StatusBadge
                  value={live?.process ?? agent.process}
                  testId={`agents-row-${agent.name}-process-badge`}
                />
              </td>
              <td className="px-2 py-2">
                <StatusBadge value={live?.health ?? agent.health} />
              </td>
              <td className="px-2 py-2">
                <StatusBadge value={agent.container} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
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
      className="space-y-3 rounded border border-edge bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Field label="name" error={errors.name}>
        <input
          data-testid="agent-create-name-input"
          className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="docker image (blank = server default)" error={errors.docker_image}>
            <input
              data-testid="agent-create-image-input"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
              value={values.docker_image}
              onChange={(e) => set('docker_image', e.target.value)}
            />
          </Field>
          <Field label="network" error={undefined}>
            <select
              data-testid="agent-create-network-select"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
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
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
              value={values.cpu}
              onChange={(e) => set('cpu', e.target.value)}
              placeholder="e.g. 2"
            />
          </Field>
          <Field label="memory (MB)" error={errors.memory_mb}>
            <input
              data-testid="agent-create-memory-input"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
              value={values.memory_mb}
              onChange={(e) => set('memory_mb', e.target.value)}
              placeholder="≥256"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="persona (SOUL.md seed)" error={errors.persona}>
              <textarea
                data-testid="agent-create-persona-input"
                rows={4}
                className="w-full rounded border border-edge bg-surface px-2 py-1.5 font-mono text-sm"
                value={values.persona}
                onChange={(e) => set('persona', e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Collapsible>

      <div className="flex justify-end">
        <button
          data-testid="agent-create-submit-button"
          type="submit"
          disabled={submitting}
          className="rounded bg-accent-strong px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create agent'}
        </button>
      </div>
    </form>
  )
}

function Field(props: {
  label: string
  error: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-dim">{props.label}</span>
      {props.children}
      {props.error && <span className="mt-1 block text-xs text-bad">{props.error}</span>}
    </label>
  )
}
