/** Single API gate (WPT-2): every server call goes through `request` —
 * token attach, error normalization (the three observed body shapes),
 * 30s timeout for plain calls, a single 401 signal. Components never call
 * fetch directly. */

import type {
  AgentRecord,
  AgentStatus,
  AlertsSnapshot,
  ApprovalsMode,
  DeepStatus,
  GatewayInfo,
  GatewayWindow,
  JobSnapshot,
  ObservabilityGateway,
  ObservabilityUsage,
  UsageRange,
} from '../lib/types'

export const REQUEST_TIMEOUT_MS = 30_000

export class ApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** {"error": str} | {"detail": str} | {"error": {"message": str}} — U3-verified. */
export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const error = record['error']
    if (typeof error === 'string' && error) return error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message']
      if (typeof message === 'string' && message) return message
    }
    const detail = record['detail']
    if (typeof detail === 'string' && detail) return detail
  }
  return fallback
}

export interface ClientOptions {
  getToken: () => string | null
  onUnauthorized: () => void
  fetchFn?: typeof fetch
  baseUrl?: string
}

interface RequestInitLite {
  json?: unknown
  headers?: Record<string, string>
  /** streams (SSE, logs follow) run without a timeout (U4-REL-3) */
  stream?: boolean
  signal?: AbortSignal
}

export class ApiClient {
  private readonly options: ClientOptions
  private readonly fetchFn: typeof fetch

  constructor(options: ClientOptions) {
    this.options = options
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async raw(method: string, path: string, init: RequestInitLite = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers }
    const token = this.options.getToken()
    if (token) headers['X-Caduceus-Token'] = token
    let body: string | undefined
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const controller = new AbortController()
    const timer = init.stream ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    if (init.signal) {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let response: Response
    try {
      response = await this.fetchFn(`${this.options.baseUrl ?? ''}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      })
    } catch {
      if (timer) clearTimeout(timer)
      throw new ApiError('daemon unreachable', null)
    } finally {
      if (timer && !init.stream) clearTimeout(timer)
    }
    if (response.status === 401) {
      this.options.onUnauthorized()
      throw new ApiError('unauthorized', 401)
    }
    if (!response.ok) {
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        // non-JSON error body
      }
      throw new ApiError(errorMessage(body, `HTTP ${response.status}`), response.status)
    }
    return response
  }

  async request<T>(method: string, path: string, init: RequestInitLite = {}): Promise<T> {
    const response = await this.raw(method, path, init)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  // -- agents (C5 contract) --------------------------------------------------

  listAgents(): Promise<AgentStatus[]> {
    return this.request('GET', '/api/agents')
  }

  getAgent(name: string): Promise<{ record: AgentRecord; status: AgentStatus }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}`)
  }

  createAgent(spec: Record<string, unknown>): Promise<{ job_id: string }> {
    return this.request('POST', '/api/agents', { json: spec })
  }

  /** W1: the confirmed name travels as X-Confirm — only ConfirmModal calls this. */
  removeAgent(name: string, confirmedName: string): Promise<{ job_id: string }> {
    return this.request('DELETE', `/api/agents/${encodeURIComponent(name)}`, {
      headers: { 'X-Confirm': confirmedName },
    })
  }

  startAgent(name: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/agents/${encodeURIComponent(name)}/start`)
  }

  stopAgent(name: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/agents/${encodeURIComponent(name)}/stop`)
  }

  logs(name: string, last: number): Promise<{ lines: string[] }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/logs?last=${last}`)
  }

  rotateToken(name: string): Promise<void> {
    return this.request('POST', `/api/agents/${encodeURIComponent(name)}/token/rotate`)
  }

  getSoul(name: string): Promise<{ content: string }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/soul`)
  }

  putSoul(name: string, content: string): Promise<void> {
    return this.request('PUT', `/api/agents/${encodeURIComponent(name)}/soul`, {
      json: { content },
    })
  }

  getSkills(name: string): Promise<{ skills: { name: string; enabled: boolean }[] }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/skills`)
  }

  toggleSkill(name: string, skill: string, enabled: boolean): Promise<void> {
    return this.request(
      'PUT',
      `/api/agents/${encodeURIComponent(name)}/skills/${encodeURIComponent(skill)}`,
      { json: { enabled } },
    )
  }

  getApprovals(name: string): Promise<{ mode: ApprovalsMode }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/approvals`)
  }

  putApprovals(name: string, mode: ApprovalsMode): Promise<void> {
    return this.request('PUT', `/api/agents/${encodeURIComponent(name)}/approvals`, {
      json: { mode },
    })
  }

  getAllowPrivateUrls(name: string): Promise<{ allow_private_urls: boolean }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/allow-private-urls`)
  }

  putAllowPrivateUrls(name: string, allow: boolean): Promise<void> {
    return this.request('PUT', `/api/agents/${encodeURIComponent(name)}/allow-private-urls`, {
      json: { allow },
    })
  }

  getToolsets(name: string): Promise<{ toolsets: string[] }> {
    return this.request('GET', `/api/agents/${encodeURIComponent(name)}/toolsets`)
  }

  putToolsets(name: string, toolsets: string[]): Promise<void> {
    return this.request('PUT', `/api/agents/${encodeURIComponent(name)}/toolsets`, {
      json: { toolsets },
    })
  }

  // -- gateway / jobs / status ------------------------------------------------

  gatewayInfo(): Promise<GatewayInfo> {
    return this.request('GET', '/api/gateway')
  }

  putUpstream(body: {
    base_url: string
    default_model: string
    api_key_env: string | null
  }): Promise<{ base_url: string; default_model: string }> {
    return this.request('PUT', '/api/gateway/upstream', { json: body })
  }

  listJobs(): Promise<JobSnapshot[]> {
    return this.request('GET', '/api/jobs')
  }

  getJob(jobId: string): Promise<JobSnapshot> {
    return this.request('GET', `/api/jobs/${encodeURIComponent(jobId)}`)
  }

  deepStatus(): Promise<DeepStatus> {
    return this.request('GET', '/api/status')
  }

  /** Drift/orphan conditions active as of the last reconcile cycle. */
  getAlerts(): Promise<AlertsSnapshot> {
    return this.request('GET', '/api/alerts')
  }

  // -- observability -------------------------------------------------------------

  /** Persistent (hermes session) aggregate — daemon-side fan-out + bucketing. */
  observabilityUsage(range: UsageRange, agent?: string): Promise<ObservabilityUsage> {
    const query = agent ? `&agent=${encodeURIComponent(agent)}` : ''
    return this.request('GET', `/api/observability/usage?range=${range}${query}`)
  }

  /** Volatile gateway aggregate (latency/errors) — "since daemon start". */
  observabilityGateway(window: GatewayWindow, agent?: string): Promise<ObservabilityGateway> {
    const query = agent ? `&agent=${encodeURIComponent(agent)}` : ''
    return this.request('GET', `/api/observability/gateway?window=${window}${query}`)
  }

  /** Reap + delete an orphaned resource (alert "clean up"). */
  resolveOrphan(resource: 'profile' | 'container', name: string): Promise<{ job_id: string }> {
    return this.request('POST', '/api/alerts/orphan/resolve', {
      json: { resource, name },
    })
  }

  // -- agent api_server relay (S2) ---------------------------------------------

  agentApi<T>(agent: string, method: string, subpath: string, json?: unknown): Promise<T> {
    return this.request(`${method}`, `/agents/${encodeURIComponent(agent)}/api/${subpath}`, {
      json,
    })
  }

  /** SSE / long streams through the relay — no timeout (U4-REL-3). */
  agentApiStream(agent: string, subpath: string, signal?: AbortSignal): Promise<Response> {
    return this.raw('GET', `/agents/${encodeURIComponent(agent)}/api/${subpath}`, {
      stream: true,
      signal,
    })
  }
}
