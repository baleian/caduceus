/** Client-side validation (W4 — UX only; the server is authoritative) and
 * text⇄list round-trip for the toolsets editor (PU4-5). */

/** Single constants mirrored from the server (types.py / SECURITY-05). */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/
export const RESERVED_AGENT_NAMES = new Set(['default'])
export const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/
export const MAX_IMAGE_LEN = 512
export const MAX_PERSONA_BYTES = 64 * 1024 // server V5
export const MAX_SOUL_BYTES = 512 * 1024 // client cap under the 1MB body limit (B1)

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function validateAgentName(name: string): string | null {
  if (!name) return 'name is required'
  if (!AGENT_NAME_RE.test(name)) return 'must match ^[a-z0-9][a-z0-9_-]{0,59}$'
  if (RESERVED_AGENT_NAMES.has(name)) return `'${name}' is reserved`
  return null
}

export interface AgentFormValues {
  name: string
  docker_image: string
  network_mode: string
  allow_private_urls: boolean
  cpu: string
  memory_mb: string
  persona: string
}

export type FieldErrors = Partial<Record<keyof AgentFormValues, string>>

export function validateAgentForm(values: AgentFormValues): FieldErrors {
  const errors: FieldErrors = {}
  const nameError = validateAgentName(values.name.trim())
  if (nameError) errors.name = nameError
  const image = values.docker_image.trim()
  if (image.length > MAX_IMAGE_LEN) errors.docker_image = `must be ≤${MAX_IMAGE_LEN} chars`
  if (values.cpu.trim()) {
    const cpu = Number(values.cpu)
    if (!Number.isFinite(cpu) || cpu <= 0) errors.cpu = 'must be a positive number'
  }
  if (values.memory_mb.trim()) {
    const memory = Number(values.memory_mb)
    if (!Number.isInteger(memory) || memory < 256) errors.memory_mb = 'must be an integer ≥256'
  }
  if (utf8Bytes(values.persona) > MAX_PERSONA_BYTES) {
    errors.persona = 'persona exceeds 64KB'
  }
  return errors
}

export function validateUpstream(
  baseUrl: string,
  apiKeyEnv: string,
): FieldErrors & {
  base_url?: string
  api_key_env?: string
} {
  const errors: { base_url?: string; api_key_env?: string } = {}
  if (!/^https?:\/\/\S+$/.test(baseUrl.trim())) errors.base_url = 'must be an http(s) URL'
  if (apiKeyEnv.trim() && !ENV_VAR_RE.test(apiKeyEnv.trim())) {
    errors.api_key_env = 'must be an env var name (^[A-Z_][A-Z0-9_]*$)'
  }
  return errors
}

/** Toolsets editor round-trip (PU4-5): one entry per line; blanks dropped,
 * entries trimmed. render∘parse and parse∘render are lossless for canonical
 * entries (non-empty, no leading/trailing whitespace, no newlines). */
export function parseToolsetsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function renderToolsetsText(toolsets: readonly string[]): string {
  return toolsets.join('\n')
}
