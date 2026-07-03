/** Per-agent hermes-native usage: fan-out over agents, summing each agent's
 * session usage (shared by Dashboard and Gateway — extracted from the Q7=A
 * Gateway page unchanged). An unreachable/stopped agent degrades to
 * `reachable: false` rather than failing the whole set. */

import { useCallback, useEffect, useState } from 'react'

import { listSessions } from '../api/agentApi'
import { useApp } from './AppStore'

export interface AgentUsage {
  agent: string
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  reachable: boolean
}

export function useAgentUsage(): { usage: AgentUsage[] | null; reload: () => Promise<void> } {
  const { client } = useApp()
  const [usage, setUsage] = useState<AgentUsage[] | null>(null)

  const reload = useCallback(async () => {
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
    void reload()
  }, [reload])

  return { usage, reload }
}
