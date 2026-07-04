/** Server DTOs (WPT-12: explicit receive types — no speculative fields). */

export type DesiredState = 'running' | 'stopped'
export type NetworkMode = 'host' | 'bridge_hostgw' | 'none'
export type ApprovalsMode = 'off' | 'smart' | 'manual'

/** GET /api/agents item — AgentStatus.model_dump() */
export interface AgentStatus {
  name: string
  desired_state: DesiredState
  process: string
  health: string
  container: string
  detail: Record<string, unknown>
}

/** GET /api/agents/{name} — public record part (S3: no secrets) */
export interface AgentRecord {
  spec: {
    name: string
    docker_image: string
    network_mode: NetworkMode
    allow_private_urls: boolean
    approvals_mode: ApprovalsMode
    cpu: number | null
    memory_mb: number | null
    disk_mb: number | null
    persona: string | null
  }
  profile_name: string
  api_port: number
  workspace_dir: string
  created_at: string
  desired_state: DesiredState
}

/** WS /api/events frame — CoreEvent.model_dump_json() */
export interface CoreEvent {
  kind: string
  agent: string | null
  data: Record<string, unknown>
  ts: string
}

/** GET /api/alerts item — a drift/orphan condition active right now.
 * key: "drift:{agent}:{reason}" | "orphan:{resource}:{name}" (daemon-shared). */
export interface ActiveAlert {
  key: string
  kind: 'drift' | 'orphan'
  since: string
  agent?: string
  reason?: string
  keys?: string[]
  resource?: string
  name?: string
}

export interface AlertsSnapshot {
  alerts: ActiveAlert[]
  checked_at: string | null
}

/** GET /api/jobs[/{id}] — Job.snapshot() */
export interface JobSnapshot {
  id: string
  kind: string
  agent: string
  state: string
  error: string | null
  created_at: string
  finished_at: string | null
  steps: { name: string; state: string }[]
}

export interface TrafficAgentSummary {
  requests: number
  errors: number
  last_request_at: string | null
}

/** GET /api/gateway */
export interface GatewayInfo {
  listen: { host: string; port: number }
  upstream: {
    base_url: string
    default_model: string
    api_key_env: string | null
    extra_headers: string[]
  }
  traffic: {
    since: string
    totals: { requests: number; errors: number }
    agents: Record<string, TrafficAgentSummary>
  }
}

/** GET /api/status */
export interface DeepStatus {
  agents: Record<string, string>
  traffic: { requests: number; errors: number }
  upstream: string
}

/* -- observability (observability-redesign S5) --------------------------------
 * Two read-only aggregates served by the daemon. `usage` is hermes-native and
 * persistent; `gateway` is TrafficStats — volatile, scoped "since daemon
 * start". Shapes mirror caduceus/control/api.py responses exactly. */

/** One zero-filled bucket of the persistent (session-derived) series. */
export interface UsageBucket {
  start_s: number
  requests: number
  sessions: number
  messages: number
  tool_calls: number
  cost_usd: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
}

export interface UsageKpis {
  requests: number
  sessions: number
  active_sessions: number
  messages: number
  tool_calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  cost_usd: number
  actual_cost_usd: number
  avg_duration_s: number
  cache_hit_ratio: number
}

export interface DistributionRow {
  model?: string
  source?: string
  requests: number
  sessions: number
  tokens: number
  cost_usd: number
}

export interface RankingRow {
  agent: string
  reachable: boolean
  requests: number
  sessions: number
  active_sessions: number
  tokens: number
  cost_usd: number
  tool_calls: number
}

/** Per-session narrow-down row (metadata + metrics only; no content). */
export interface UsageSessionRow {
  id: string | null
  title: string | null
  model: string | null
  source: string | null
  started_at: number | null
  last_active: number | null
  ended_at: number | null
  duration_s: number
  requests: number
  messages: number
  tool_calls: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  reasoning_tokens: number
  cost_usd: number
}

export interface UsageScope {
  kpis: UsageKpis
  series: UsageBucket[]
  by_model: DistributionRow[]
  by_source: DistributionRow[]
}

export type UsageRange = '24h' | '7d' | '30d'

/** GET /api/observability/usage */
export interface ObservabilityUsage {
  generated_at: string
  range: UsageRange
  bucket_s: number
  fleet: UsageScope & { ranking: RankingRow[] }
  agent: (UsageScope & { name: string; reachable: boolean; sessions: UsageSessionRow[] }) | null
  unreachable: string[]
}

export interface GatewayBucket {
  start_s: number
  requests: number
  errors: number
  avg_latency_ms: number
}

export interface GatewayRecentRow {
  ts: string
  agent: string
  model: string
  status: number
  latency_ms: number
}

export type GatewayWindow = '15m' | '1h' | '24h'

/** GET /api/observability/gateway — volatile ("since daemon start"). */
export interface ObservabilityGateway {
  since: string
  window: GatewayWindow
  bucket_s: number
  totals: { requests: number; errors: number }
  latency: { avg: number; p50: number; p95: number; max: number; count: number }
  series: GatewayBucket[]
  per_agent: Record<string, TrafficAgentSummary>
  recent: GatewayRecentRow[]
}

/** api_server session (via /agents/{name}/api/api/sessions).
 * Token usage is hermes-native: cumulative per-session counts (cache split
 * out), populated by hermes' update_token_counts. Optional — older sessions
 * or non-usage-tracking runs may omit them. */
export interface SessionInfo {
  id: string
  title?: string | null
  started_at?: string | null
  last_active?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
  estimated_cost_usd?: number | null
}

/** A persisted assistant tool call (OpenAI-style function call shape). */
export interface SessionToolCall {
  id?: string | null
  call_id?: string | null
  type?: string | null
  function?: {
    name?: string | null
    arguments?: string | null
  } | null
}

/** api_server persisted message. Assistant turns may carry `reasoning`
 * (the model's thinking) and `tool_calls`; tool results carry `tool_name`
 * and `tool_call_id` pointing back at the originating call. */
export interface SessionMessage {
  role?: string
  content?: unknown
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: SessionToolCall[] | null
  tool_name?: string | null
  tool_call_id?: string | null
}
