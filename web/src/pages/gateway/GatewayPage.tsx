/** Gateway page (Q7=A): upstream form (hot-swap), per-agent traffic summary
 * fed by REST snapshot + live traffic events, recent request metadata list
 * (ring buffer ≤100 — bodies are never stored server-side). */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { validateUpstream } from '../../lib/forms'
import type { GatewayInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'

export function GatewayPage(): ReactNode {
  const { client, state, toast } = useApp()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
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

  useEffect(() => {
    void refetch()
  }, [refetch])

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

      {info && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            Traffic since {info.traffic.since}
            <span className="ml-2 font-normal text-ink-dim">
              {info.traffic.totals.requests} requests · {info.traffic.totals.errors} errors ·{' '}
              {info.traffic.totals.input_tokens}/{info.traffic.totals.output_tokens} tokens
            </span>
          </h2>
          <table className="w-full border-collapse text-sm" data-testid="gateway-traffic-table">
            <thead>
              <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-ink-dim">
                <th className="px-2 py-1.5">agent</th>
                <th className="px-2 py-1.5">requests</th>
                <th className="px-2 py-1.5">errors</th>
                <th className="px-2 py-1.5">in / out tokens</th>
                <th className="px-2 py-1.5">last request</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(info.traffic.agents).map(([name, summary]) => (
                <tr key={name} className="border-b border-edge/60">
                  <td className="px-2 py-1.5 font-medium">{name}</td>
                  <td className="px-2 py-1.5">{summary.requests}</td>
                  <td className="px-2 py-1.5">{summary.errors}</td>
                  <td className="px-2 py-1.5">
                    {summary.input_tokens} / {summary.output_tokens}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">
                    {summary.last_request_at ?? '—'}
                  </td>
                </tr>
              ))}
              {Object.keys(info.traffic.agents).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-4 text-center text-ink-dim">
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
                <span className="text-ink-dim">
                  {request.latencyMs}ms · {request.inputTokens}/{request.outputTokens} tok
                </span>
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
