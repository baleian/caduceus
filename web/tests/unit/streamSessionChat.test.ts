/** chat-sessions-migration S2/S8 — streamSessionChat opens the sessions chat
 * stream with a POST {message} body and maps NAMED SSE events (the `event:`
 * name, not a field inside the JSON) to {kind, payload}. Frames whose data is
 * not a JSON object are dropped (PU4-1 posture). Injected fetch (WPT-10). */
import { describe, expect, it } from 'vitest'

import { streamSessionChat, type SessionStreamEvent } from '../../src/api/agentApi'
import { ApiClient } from '../../src/api/client'

function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface Captured {
  url: string
  method: string
  body: string | undefined
}

function makeClient(sse: string) {
  const calls: Captured[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    })
    return sseResponse(sse)
  }) as typeof fetch
  const client = new ApiClient({ getToken: () => 't', onUnauthorized: () => {}, fetchFn })
  return { client, calls }
}

// named SSE frames: comment keepalive, invalid-JSON data, and a JSON array
// payload are all dropped; the rest map through in order.
const FRAMES =
  [
    'event: run.started\ndata: {"run_id":"run_1","session_id":"s1"}',
    'event: assistant.delta\ndata: {"delta":"hi"}',
    ': keepalive',
    'event: tool.progress\ndata: {"tool_name":"_thinking","delta":"pondering"}',
    'event: garbage\ndata: {not valid json}',
    'event: arr\ndata: [1,2,3]',
    'event: approval.request\ndata: {"command":"rm -rf /","choices":["once","deny"],"run_id":"run_1"}',
    'event: done\ndata: {}',
  ].join('\n\n') + '\n\n'

describe('streamSessionChat', () => {
  it('POSTs {message} to the sessions chat stream and maps named events', async () => {
    const { client, calls } = makeClient(FRAMES)
    const events: SessionStreamEvent[] = []
    await streamSessionChat(client, 'a1', 's1', 'hello', (e) => events.push(e))

    // request: POST body + relay subpath (double api/ is the relay prefix + native path)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('/agents/a1/api/api/sessions/s1/chat/stream')
    expect(calls[0]!.body).toBe(JSON.stringify({ message: 'hello' }))

    // only well-formed object frames survive, in arrival order
    expect(events.map((e) => e.kind)).toEqual([
      'run.started',
      'assistant.delta',
      'tool.progress',
      'approval.request',
      'done',
    ])
    expect(events[0]!.payload['run_id']).toBe('run_1')
    expect(events[2]!.payload['tool_name']).toBe('_thinking')
    expect(events[3]!.payload['command']).toBe('rm -rf /')
  })

  it('resolves quietly when the response has no body', async () => {
    const fetchFn = (async () => new Response(null, { status: 200 })) as typeof fetch
    const client = new ApiClient({ getToken: () => 't', onUnauthorized: () => {}, fetchFn })
    const events: SessionStreamEvent[] = []
    await expect(
      streamSessionChat(client, 'a1', 's1', 'hi', (e) => events.push(e)),
    ).resolves.toBeUndefined()
    expect(events).toEqual([])
  })
})
