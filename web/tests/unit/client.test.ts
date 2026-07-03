/** WPT-2 — API gate contract: token attach, error normalization (3 shapes),
 * single 401 signal, X-Confirm only via removeAgent. Injected fetch (WPT-10). */
import { describe, expect, it, vi } from 'vitest'

import { ApiClient, ApiError, errorMessage } from '../../src/api/client'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function makeClient(
  respond: (captured: Captured) => Response | Promise<Response>,
  onUnauthorized = vi.fn(),
) {
  const calls: Captured[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    }
    calls.push(captured)
    return respond(captured)
  }) as typeof fetch
  const client = new ApiClient({
    getToken: () => 'tok-123',
    onUnauthorized,
    fetchFn,
  })
  return { client, calls, onUnauthorized }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('ApiClient', () => {
  it('attaches the admin token header on every call', async () => {
    const { client, calls } = makeClient(() => ok([]))
    await client.listAgents()
    expect(calls[0]!.headers['X-Caduceus-Token']).toBe('tok-123')
    expect(calls[0]!.url).toBe('/api/agents')
  })

  it('normalizes the three error body shapes', async () => {
    expect(errorMessage({ error: 'plain' }, 'f')).toBe('plain')
    expect(errorMessage({ detail: 'detail-form' }, 'f')).toBe('detail-form')
    expect(errorMessage({ error: { message: 'nested', code: 'x' } }, 'f')).toBe('nested')
    expect(errorMessage('garbage', 'fallback')).toBe('fallback')

    const { client } = makeClient(
      () => new Response(JSON.stringify({ detail: 'boom' }), { status: 409 }),
    )
    await expect(client.startAgent('a1')).rejects.toMatchObject({ message: 'boom', status: 409 })
  })

  it('fires the 401 signal exactly once per unauthorized response', async () => {
    const { client, onUnauthorized } = makeClient(
      () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    )
    await expect(client.listAgents()).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('sends X-Confirm only through removeAgent (W1)', async () => {
    const { client, calls } = makeClient(() => ok({ job_id: 'j1' }))
    await client.removeAgent('a1', 'a1')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.headers['X-Confirm']).toBe('a1')
  })

  it('maps network failure to a daemon-unreachable ApiError', async () => {
    const { client } = makeClient(() => {
      throw new TypeError('fetch failed')
    })
    await expect(client.listAgents()).rejects.toMatchObject({
      message: 'daemon unreachable',
      status: null,
    })
  })

  it('returns undefined for 204 bodies (soul/skills/toolsets puts)', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }))
    await expect(client.putSoul('a1', 'persona')).resolves.toBeUndefined()
    expect(JSON.parse(calls[0]!.body!)).toEqual({ content: 'persona' })
  })

  it('routes agent relay calls under /agents/{name}/api/', async () => {
    const { client, calls } = makeClient(() => ok({ data: [] }))
    await client.agentApi('a1', 'GET', 'api/sessions')
    expect(calls[0]!.url).toBe('/agents/a1/api/api/sessions')
  })
})
