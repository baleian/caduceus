/** /chat — resumes the last conversation (or the first agent); the picker is
 * gone (redesign: agent selection is an inline switcher inside the conversation
 * at /chat/{name}). Only the empty-fleet case renders here — and only once the
 * first agent fetch has resolved, so a cold load doesn't flash "no agents". */

import { MessageSquare } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'

import { EmptyState } from '../../components/ui/EmptyState'
import { loadPrefs } from '../../state/prefs'
import { useApp } from '../../state/AppStore'

export function ChatPage(): ReactNode {
  const { state, refetchAgents } = useApp()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.resolve(refetchAgents()).finally(() => {
      if (alive) setChecked(true)
    })
    return () => {
      alive = false
    }
  }, [refetchAgents])

  if (state.agents.length === 0) {
    // avoid flashing the empty state before the first agent fetch resolves
    if (!checked) return null
    return (
      <EmptyState
        icon={MessageSquare}
        title="No agents to chat with"
        description="Create one on the Agents page first."
      />
    )
  }

  const last = loadPrefs().lastChatAgent
  const target = last && state.agents.some((a) => a.name === last) ? last : state.agents[0]!.name
  return <Navigate to={`/chat/${encodeURIComponent(target)}`} replace />
}
