/** Gateway (Q7=A, redesign §6.5): upstream hot-swap card, per-agent token
 * usage as a validated stacked bar chart + table (chart relief rule), request
 * traffic table, and the live request feed. Usage is hermes-native — summed
 * from each agent's sessions via the shared useAgentUsage fan-out. */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { ApiError } from '../../api/client'
import { UsageBarChart } from '../../components/lazy'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Field, INPUT_MONO_CLASS } from '../../components/ui/Field'
import { PageHeader } from '../../components/ui/PageHeader'
import { Skeleton } from '../../components/ui/Skeleton'
import { validateUpstream } from '../../lib/forms'
import type { GatewayInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'
import { useAgentUsage } from '../../state/useAgentUsage'

const fmt = (n: number): string => n.toLocaleString('en-US')

const TH_CLASS = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-faint'
const TD_CLASS = 'px-3 py-2'

export function GatewayPage(): ReactNode {
  const { client, state, toast } = useApp()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const { usage, reload: reloadUsage } = useAgentUsage()
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

  const usageRows = (usage ?? []).filter((u) => u.reachable)
  const hasTokenData = usageRows.some((u) => u.inputTokens + u.cacheReadTokens + u.outputTokens > 0)

  return (
    <div>
      <PageHeader
        title="Gateway"
        description="one proxy in front of every agent — upstream, usage and traffic"
      />

      <div className="grid gap-4 2xl:grid-cols-2">
        <Card className="2xl:col-span-2">
          <CardHeader
            title="Upstream"
            subtitle="hot-swap — one place for every agent"
            actions={
              <Button
                testId="gateway-upstream-save-button"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Applying…' : 'Apply'}
              </Button>
            }
          />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Field label="base_url" error={errors.base_url}>
                <input
                  data-testid="gateway-upstream-url-input"
                  className={INPUT_MONO_CLASS}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Field>
            </div>
            <Field label="default model">
              <input
                data-testid="gateway-upstream-model-input"
                className={INPUT_MONO_CLASS}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <div className="lg:col-span-2">
              <Field
                label="api key env var"
                hint="name only — the value never leaves the daemon host"
                error={errors.api_key_env}
              >
                <input
                  data-testid="gateway-upstream-keyenv-input"
                  className={INPUT_MONO_CLASS}
                  placeholder="e.g. OPENAI_API_KEY"
                  value={apiKeyEnv}
                  onChange={(e) => setApiKeyEnv(e.target.value)}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Token usage"
            subtitle="per agent — summed from hermes sessions"
            actions={
              <Button
                variant="outline"
                size="xs"
                testId="gateway-usage-refresh-button"
                onClick={() => void reloadUsage()}
              >
                <RefreshCw size={12} aria-hidden /> Refresh
              </Button>
            }
          />
          {usage === null ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              {hasTokenData && <UsageBarChart rows={usageRows} />}
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-sm" data-testid="gateway-usage-table">
                  <thead>
                    <tr className="border-b border-edge">
                      <th className={TH_CLASS}>agent</th>
                      <th className={TH_CLASS}>sessions</th>
                      <th className={TH_CLASS}>input</th>
                      <th className={TH_CLASS}>cache read</th>
                      <th className={TH_CLASS}>output</th>
                      <th className={TH_CLASS}>est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usage ?? []).map((u) => (
                      <tr key={u.agent} className="border-b border-edge/60 last:border-0">
                        <td className={`${TD_CLASS} font-medium`}>{u.agent}</td>
                        <td className={`${TD_CLASS} tabular-nums`}>
                          {u.reachable ? (
                            u.sessions
                          ) : (
                            <span className="text-ink-faint">unreachable</span>
                          )}
                        </td>
                        <td className={`${TD_CLASS} tabular-nums`}>{fmt(u.inputTokens)}</td>
                        <td className={`${TD_CLASS} tabular-nums`}>{fmt(u.cacheReadTokens)}</td>
                        <td className={`${TD_CLASS} tabular-nums`}>{fmt(u.outputTokens)}</td>
                        <td className={`${TD_CLASS} font-mono text-xs`}>${u.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                    {usage != null && usage.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-ink-dim">
                          no agents
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>

        <div className="space-y-4">
          {info && (
            <Card>
              <CardHeader
                title="Request traffic"
                subtitle={
                  <>
                    since {info.traffic.since} — {fmt(info.traffic.totals.requests)} requests ·{' '}
                    {fmt(info.traffic.totals.errors)} errors
                  </>
                }
                actions={
                  <Button
                    variant="outline"
                    size="xs"
                    testId="gateway-refresh-button"
                    onClick={() => void refetch()}
                  >
                    <RefreshCw size={12} aria-hidden /> Refresh
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table
                  className="w-full border-collapse text-sm"
                  data-testid="gateway-traffic-table"
                >
                  <thead>
                    <tr className="border-b border-edge">
                      <th className={TH_CLASS}>agent</th>
                      <th className={TH_CLASS}>requests</th>
                      <th className={TH_CLASS}>errors</th>
                      <th className={TH_CLASS}>last request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(info.traffic.agents).map(([name, summary]) => (
                      <tr key={name} className="border-b border-edge/60 last:border-0">
                        <td className={`${TD_CLASS} font-medium`}>{name}</td>
                        <td className={`${TD_CLASS} tabular-nums`}>{fmt(summary.requests)}</td>
                        <td
                          className={`${TD_CLASS} tabular-nums ${summary.errors > 0 ? 'text-bad' : ''}`}
                        >
                          {fmt(summary.errors)}
                        </td>
                        <td className={`${TD_CLASS} font-mono text-xs text-ink-dim`}>
                          {summary.last_request_at ?? '—'}
                        </td>
                      </tr>
                    ))}
                    {Object.keys(info.traffic.agents).length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-ink-dim">
                          no proxied requests yet
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Recent requests" subtitle="live, metadata only" />
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
                    className="flex items-center gap-3 rounded-lg bg-panel-2 px-2.5 py-1.5"
                  >
                    <span className="text-ink-faint">{request.ts}</span>
                    <span className="font-medium text-ink">{request.agent ?? '?'}</span>
                    <span className="truncate text-ink-dim">{request.model}</span>
                    <span className={`ml-auto ${request.status >= 400 ? 'text-bad' : 'text-ok'}`}>
                      {request.status}
                    </span>
                    <span className="text-ink-faint">{request.latencyMs}ms</span>
                  </li>
                ))}
              {state.live.recentRequests.length === 0 && (
                <li className="py-4 text-center text-ink-dim">none since this page loaded</li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
