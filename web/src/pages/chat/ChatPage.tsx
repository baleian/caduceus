/** /chat — agent picker; the conversation lives at /chat/{name}. */

import { MessageSquare } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { StatusBadge } from '../../components/StatusBadge'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { PageHeader } from '../../components/ui/PageHeader'
import { useApp } from '../../state/AppStore'

export function ChatPage(): ReactNode {
  const { state, refetchAgents } = useApp()

  useEffect(() => {
    void refetchAgents()
  }, [refetchAgents])

  if (state.agents.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No agents to chat with"
        description="Create one on the Agents page first."
      />
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Chat" description="pick an agent to start a conversation" />
      <Card padded={false}>
        <ul className="divide-y divide-edge">
          {state.agents.map((agent) => (
            <li key={agent.name}>
              <Link
                data-testid={`chat-agent-${agent.name}-link`}
                to={`/chat/${encodeURIComponent(agent.name)}`}
                className="flex items-center justify-between px-4 py-3.5 text-sm transition-colors hover:bg-panel-2"
              >
                <span className="inline-flex items-center gap-3 font-medium">
                  <span className="rounded-lg bg-accent/10 p-1.5 text-accent">
                    <MessageSquare size={14} aria-hidden />
                  </span>
                  {agent.name}
                </span>
                <StatusBadge value={state.live.agents[agent.name]?.health ?? agent.health} />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
