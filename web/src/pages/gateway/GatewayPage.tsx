/** Gateway (Q7=A, redesign §6.5): upstream hot-swap is the centerpiece here.
 * Per-agent token usage & request analytics moved to Observability (the
 * source-of-truth); this page keeps only a compact per-agent Routing table for
 * proxy verification, and deeplinks the rest. Usage is hermes-native. */

import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { Button } from '../../components/ui/Button'
import { Card, CardHeader } from '../../components/ui/Card'
import { Field, INPUT_MONO_CLASS } from '../../components/ui/Field'
import { PageHeader } from '../../components/ui/PageHeader'
import { formatCount, timeAgo } from '../../lib/format'
import { validateUpstream } from '../../lib/forms'
import type { GatewayInfo } from '../../lib/types'
import { useApp } from '../../state/AppStore'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-faint'
const TH_R = `${TH} text-right`
const TD = 'px-3 py-2'

export function GatewayPage(): ReactNode {
  const { client, toast } = useApp()
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKeyEnv, setApiKeyEnv] = useState('')
  const [errors, setErrors] = useState<{ base_url?: string; api_key_env?: string }>({})
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

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

  async function doRefresh(): Promise<void> {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }

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

  const agents = info ? Object.entries(info.traffic.agents) : []

  return (
    <div>
      <PageHeader
        title="Gateway"
        description="one proxy in front of every agent — upstream & routing"
        divider
        actions={
          <Button
            variant="outline"
            testId="gateway-refresh-button"
            busy={refreshing}
            onClick={() => void doRefresh()}
          >
            <RefreshCw size={13} aria-hidden /> Refresh
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Upstream"
            subtitle="hot-swap — one endpoint for every agent"
            actions={
              <Button
                variant="primary"
                testId="gateway-upstream-save-button"
                busy={saving}
                onClick={() => void save()}
              >
                Apply
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
            <div className="lg:col-span-3">
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
          <CardHeader title="Proxy endpoint" subtitle="where clients connect" />
          {info ? (
            <dl className="space-y-2.5 text-sm">
              <Fact label="listen" value={`${info.listen.host}:${info.listen.port}`} />
              <Fact label="upstream" value={info.upstream.base_url} />
              <Fact label="model" value={info.upstream.default_model} />
              <div className="flex items-center justify-between border-t border-edge pt-2.5">
                <span className="text-ink-dim">traffic</span>
                <span className="text-xs">
                  <span className="font-medium tabular-nums">
                    {formatCount(info.traffic.totals.requests)}
                  </span>{' '}
                  req ·{' '}
                  <span
                    className={`font-medium tabular-nums ${info.traffic.totals.errors > 0 ? 'text-bad' : ''}`}
                  >
                    {formatCount(info.traffic.totals.errors)}
                  </span>{' '}
                  err
                </span>
              </div>
              <Link
                to="/observability"
                data-testid="gateway-open-observability-link"
                className="inline-flex items-center gap-0.5 pt-0.5 text-xs font-medium text-accent hover:underline"
              >
                Traffic & usage in Observability <ArrowUpRight size={12} aria-hidden />
              </Link>
            </dl>
          ) : (
            <p className="text-sm text-ink-dim">loading…</p>
          )}
        </Card>
      </div>

      {info && (
        <Card className="mt-4" padded={false}>
          <CardHeader
            className="px-4 pt-4"
            title="Routing"
            subtitle={`per-agent proxy verification · since ${timeAgo(info.traffic.since)}`}
            actions={
              <Link
                to="/observability"
                className="inline-flex items-center gap-0.5 pr-4 text-xs font-medium text-accent hover:underline"
              >
                deep analytics <ArrowUpRight size={12} aria-hidden />
              </Link>
            }
          />
          <div className="overflow-x-auto pb-1">
            <table className="w-full border-collapse text-sm" data-testid="gateway-traffic-table">
              <thead>
                <tr className="border-b border-edge">
                  <th className={TH}>agent</th>
                  <th className={TH_R}>requests</th>
                  <th className={TH_R}>errors</th>
                  <th className={TH_R}>last request</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(([name, summary]) => (
                  <tr key={name} className="border-b border-edge/60 last:border-0">
                    <td className={`${TD} font-medium`}>{name}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatCount(summary.requests)}</td>
                    <td
                      className={`${TD} text-right tabular-nums ${summary.errors > 0 ? 'text-bad' : ''}`}
                    >
                      {formatCount(summary.errors)}
                    </td>
                    <td className={`${TD} text-right text-xs text-ink-faint`}>
                      {summary.last_request_at ? timeAgo(summary.last_request_at) : '—'}
                    </td>
                  </tr>
                ))}
                {agents.length === 0 && (
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
    </div>
  )
}

function Fact(props: { label: string; value: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-dim">{props.label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-xs" title={props.value}>
        {props.value}
      </dd>
    </div>
  )
}
