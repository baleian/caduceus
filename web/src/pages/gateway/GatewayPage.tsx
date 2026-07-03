/** Gateway page (Q7=A): upstream form (hot-swap), per-agent request traffic
 * (requests/errors/latency — proxy-level metadata hermes cannot see), and a
 * per-agent token-usage table summed from each agent's hermes sessions
 * (hermes-native usage — the proxy no longer counts tokens itself). */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { listSessions } from '../../api/agentApi'
import { ApiError } from '../../api/client'
import { validateUpstream } from '../../lib/forms'
import type { GatewayInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'

const fmt = (n: number): string => n.toLocaleString('en-US')

interface AgentUsage {
  agent: string
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  reachable: boolean
}

export function GatewayPage(): ReactNode {
  const { client, state, toast } = useApp()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [usage, setUsage] = useState<AgentUsage[] | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [errors, setErrors] = useState<{ base_url?: string; api_key_env?: string }>({})
  const [saving, setSaving] = useState(false)

  const refetch = useCallback(async () => {
    try {
      const fetched = await client.gatewayInfo()
      setInfo(fetched)
      setBaseUrl(fetched.upstream.base_url)
      setModel(fetched.upstream.default_model)
      setApiKeyEnv(fetched.upstream.api_key_env ?? '')
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'failed to load gateway info')
    }
  }, [client, toast])

  // Per-agent usage = sum of that agent's hermes sessions' usage. Fan-out over
  // agents; an unreachable/stopped agent degrades to reachable:false rather than
  // failing the whole table.
  const loadUsage = useCallback(async () => {
    let agents
    try {
      agents = await client.listAgents()
    } catch {
      setUsage([])
      return
    }
    const rows = await Promise.all(
      agents.map(async (a): Promise<AgentUsage> => {
        try {
          const sessions = await listSessions(client, a.name)
          const sum = (key: keyof (typeof sessions)[number]): number =>
            sessions.reduce((n, s) => n + (Number(s[key]) || 0), 0)
          return {
            agent: a.name,
            sessions: sessions.length,
            inputTokens: sum('input_tokens'),
            outputTokens: sum('output_tokens'),
            cacheReadTokens: sum('cache_read_tokens'),
            costUsd: sum('estimated_cost_usd'),
            reachable: true,
          }
        } catch {
          return {
            agent: a.name,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
            reachable: false,
          }
        }
      }),
    )
    setUsage(rows)
  }, [client])

  useEffect(() => {
    void refetch()
    void loadUsage()
  }, [refetch, loadUsage])

  async function save(): Promise<void> {
    const found = validateUpstream(baseUrl, apiKeyEnv)
    if (!model.trim()) {
      setErrors({ ...found, base_url: found.base_url })
      toast('error', 'default model is required')
      return
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setSaving(true)
    try {
      await client.putUpstream({
        base_url: baseUrl.trim(),
        default_model: model.trim(),
        api_key_env: apiKeyEnv.trim() || null,
      })
      toast('info', 'upstream swapped — all agents now route to the new endpoint')
      await refetch()
    } catch (error) {
      toast('error', error instanceof ApiError ? error.message : 'upstream update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Gateway</h1>

      <section className="rounded border border-edge bg-panel p-4">
        <h2 className="mb-3 text-sm font-semibold">
          Upstream (hot-swap — one place for every agent)
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-dim">base_url</span>
            <input
              data-testid="gateway-upstream-url-input"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 font-mono text-sm"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {errors.base_url && <span className="text-xs text-bad">{errors.base_url}</span>}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-dim">default model</span>
            <input
              data-testid="gateway-upstream-model-input"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 font-mono text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-dim">
              api key env var (name only — the value never leaves the daemon host)
            </span>
            <input
              data-testid="gateway-upstream-keyenv-input"
              className="w-full rounded border border-edge bg-surface px-2 py-1.5 font-mono text-sm"
              placeholder="e.g. OPENAI_API_KEY"
              value={apiKeyEnv}
              onChange={(e) => setApiKeyEnv(e.target.value)}
            />
            {errors.api_key_env && <span className="text-xs text-bad">{errors.api_key_env}</span>}
          </label>
          <div className="flex items-end">
            <button
              data-testid="gateway-upstream-save-button"
              disabled={saving}
              className="rounded bg-accent-strong px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => void save()}
            >
              {saving ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Token usage (per agent — summed from hermes sessions)
          </h2>
          <button
            data-testid="gateway-usage-refresh-button"
            className="rounded border border-edge px-3 py-1 text-sm hover:bg-panel"
            onClick={() => void loadUsage()}
          >
            Refresh
          </button>
        </div>
        <table className="w-full border-collapse text-sm" data-testid="gateway-usage-table">
          <thead>
            <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-ink-dim">
              <th className="px-2 py-1.5">agent</th>
              <th className="px-2 py-1.5">sessions</th>
              <th className="px-2 py-1.5">input</th>
              <th className="px-2 py-1.5">cache read</th>
              <th className="px-2 py-1.5">output</th>
              <th className="px-2 py-1.5">est. cost</th>
            </tr>
          </thead>
          <tbody>
            {(usage ?? []).map((u) => (
              <tr key={u.agent} className="border-b border-edge/60">
                <td className="px-2 py-1.5 font-medium">{u.agent}</td>
                <td className="px-2 py-1.5">
                  {u.reachable ? u.sessions : <span className="text-ink-dim">unreachable</span>}
                </td>
                <td className="px-2 py-1.5">{fmt(u.inputTokens)}</td>
                <td className="px-2 py-1.5">{fmt(u.cacheReadTokens)}</td>
                <td className="px-2 py-1.5">{fmt(u.outputTokens)}</td>
                <td className="px-2 py-1.5 font-mono text-xs">${u.costUsd.toFixed(4)}</td>
              </tr>
            ))}
            {usage != null && usage.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-ink-dim">
                  no agents
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {info && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            Request traffic since {info.traffic.since}
            <span className="ml-2 font-normal text-ink-dim">
              {info.traffic.totals.requests} requests · {info.traffic.totals.errors} errors
            </span>
          </h2>
          <table className="w-full border-collapse text-sm" data-testid="gateway-traffic-table">
            <thead>
              <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-ink-dim">
                <th className="px-2 py-1.5">agent</th>
                <th className="px-2 py-1.5">requests</th>
                <th className="px-2 py-1.5">errors</th>
                <th className="px-2 py-1.5">last request</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(info.traffic.agents).map(([name, summary]) => (
                <tr key={name} className="border-b border-edge/60">
                  <td className="px-2 py-1.5 font-medium">{name}</td>
                  <td className="px-2 py-1.5">{summary.requests}</td>
                  <td className="px-2 py-1.5">{summary.errors}</td>
                  <td className="px-2 py-1.5 font-mono text-xs">
                    {summary.last_request_at ?? '—'}
                  </td>
                </tr>
              ))}
              {Object.keys(info.traffic.agents).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-ink-dim">
                    no proxied requests yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <button
            data-testid="gateway-refresh-button"
            className="mt-2 rounded border border-edge px-3 py-1 text-sm hover:bg-panel"
            onClick={() => void refetch()}
          >
            Refresh
          </button>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Recent requests (live, metadata only)</h2>
        <ul
          className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs"
          data-testid="gateway-recent-list"
        >
          {state.live.recentRequests
            .slice()
            .reverse()
            .map((request, index) => (
              <li
                key={index}
                className="flex gap-3 rounded border border-edge/60 bg-panel px-2 py-1"
              >
                <span className="text-ink-dim">{request.ts}</span>
                <span className="font-medium">{request.agent ?? '?'}</span>
                <span>{request.model}</span>
                <span className={request.status >= 400 ? 'text-bad' : 'text-ok'}>
                  {request.status}
                </span>
                <span className="text-ink-dim">{request.latencyMs}ms</span>
              </li>
            ))}
          {state.live.recentRequests.length === 0 && (
            <li className="text-ink-dim">none since this page loaded</li>
          )}
        </ul>
      </section>
    </div>
  )
}
