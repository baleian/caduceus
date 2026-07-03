/** Root composition: auth bootstrap (Q1=A) → AppProvider (WS + reducer) →
 * data router (4 sections — Q2=A). */

import { useMemo, useState, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'

import { ApiClient } from './api/client'
import { Shell } from './components/Shell'
import { AgentDetailPage } from './pages/agents/AgentDetailPage'
import { AgentsPage } from './pages/agents/AgentsPage'
import { ChatPage } from './pages/chat/ChatPage'
import { ChatView } from './pages/chat/ChatView'
import { GatewayPage } from './pages/gateway/GatewayPage'
import { SystemPage } from './pages/system/SystemPage'
import { AppProvider } from './state/AppStore'
import { consumeFragmentToken, loadToken, saveToken } from './state/auth'

export function App(): ReactNode {
  const [token, setToken] = useState<string | null>(() => consumeFragmentToken() ?? loadToken())
  const [invalid, setInvalid] = useState(false)

  if (!token || invalid) {
    return (
      <TokenGate
        invalid={invalid}
        onSubmit={(entered) => {
          saveToken(entered)
          setToken(entered)
          setInvalid(false)
        }}
      />
    )
  }

  return (
    <AuthedApp
      token={token}
      onUnauthorized={() => {
        // keep the token in the input for correction (W3), just gate the app
        setInvalid(true)
      }}
    />
  )
}

function AuthedApp(props: { token: string; onUnauthorized: () => void }): ReactNode {
  const { token, onUnauthorized } = props
  const client = useMemo(
    () => new ApiClient({ getToken: () => token, onUnauthorized }),
    [token, onUnauthorized],
  )

  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          element: <Shell />,
          children: [
            { path: '/', element: <Navigate to="/agents" replace /> },
            { path: '/agents', element: <AgentsPage /> },
            { path: '/agents/:name', element: <AgentDetailPage /> },
            { path: '/chat', element: <ChatPage /> },
            { path: '/chat/:name', element: <ChatView /> },
            { path: '/gateway', element: <GatewayPage /> },
            { path: '/system', element: <SystemPage /> },
            { path: '*', element: <Navigate to="/agents" replace /> },
          ],
        },
      ]),
    [],
  )

  return (
    <AppProvider client={client} token={token}>
      <RouterProvider router={router} />
    </AppProvider>
  )
}

function TokenGate(props: { invalid: boolean; onSubmit: (token: string) => void }): ReactNode {
  const [entered, setEntered] = useState('')
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        data-testid="token-gate-form"
        className="w-full max-w-md space-y-4 rounded-lg border border-edge bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (entered.trim()) props.onSubmit(entered.trim())
        }}
      >
        <h1 className="text-lg font-semibold">☤ Caduceus</h1>
        <p className="text-sm text-ink-dim">
          Enter the admin token. The easy way: run <code className="font-mono">caduceus ui</code> —
          it opens this page with the token attached. Manually, it lives at{' '}
          <code className="font-mono">~/.caduceus/admin.token</code>.
        </p>
        {props.invalid && (
          <p data-testid="token-gate-error" className="text-sm text-bad">
            The daemon rejected that token (401). Check it and try again.
          </p>
        )}
        <input
          data-testid="token-gate-input"
          type="password"
          autoFocus
          className="w-full rounded border border-edge bg-surface px-3 py-2 font-mono text-sm"
          placeholder="admin token"
          value={entered}
          onChange={(e) => setEntered(e.target.value)}
        />
        <button
          data-testid="token-gate-submit-button"
          type="submit"
          disabled={!entered.trim()}
          className="w-full rounded bg-accent-strong px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Connect
        </button>
      </form>
    </div>
  )
}
