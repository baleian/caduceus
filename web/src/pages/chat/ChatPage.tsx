/** /chat — agent picker; the conversation lives at /chat/{name}. */

import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { StatusBadge } from '../../components/StatusBadge'
import { useApp } from '../../state/AppStore'

export function ChatPage(): ReactNode {
  const { state, refetchAgents } = useApp()

  useEffect(() => {
    void refetchAgents()
  }, [refetchAgents])

  if (state.agents.length === 0) {
    return (
      <p className="rounded border border-dashed border-edge p-6 text-center text-sm text-ink-dim">
        No agents to chat with — create one on the Agents page first.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Chat</h1>
      <ul className="divide-y divide-edge rounded border border-edge bg-panel">
        {state.agents.map((agent) => (
          <li key={agent.name}>
            <Link
              data-testid={`chat-agent-${agent.name}-link`}
              to={`/chat/${encodeURIComponent(agent.name)}`}
              className="flex items-center justify-between px-4 py-3 text-sm hover:bg-surface"
            >
              <span className="font-medium">{agent.name}</span>
              <StatusBadge value={state.live.agents[agent.name]?.health ?? agent.health} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
