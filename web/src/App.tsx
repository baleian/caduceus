/** Root composition: auth bootstrap (Q1=A) → AppProvider (WS + reducer) →
 * data router. Redesign: Dashboard is the landing section (redesign Q2=A). */

import { KeyRound } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'

import { ApiClient } from './api/client'
import { BrandIcon } from './components/Brand'
import { Shell } from './components/Shell'
import { Button } from './components/ui/Button'
import { INPUT_MONO_CLASS } from './components/ui/Field'
import { AgentDetailPage } from './pages/agents/AgentDetailPage'
import { AgentsPage } from './pages/agents/AgentsPage'
import { ChatPage } from './pages/chat/ChatPage'
import { ChatView } from './pages/chat/ChatView'
import { DashboardPage } from './pages/dashboard/DashboardPage'
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
            { path: '/', element: <DashboardPage /> },
            { path: '/agents', element: <AgentsPage /> },
            { path: '/agents/:name', element: <AgentDetailPage /> },
            { path: '/chat', element: <ChatPage /> },
            { path: '/chat/:name', element: <ChatView /> },
            { path: '/gateway', element: <GatewayPage /> },
            { path: '/system', element: <SystemPage /> },
            { path: '*', element: <Navigate to="/" replace /> },
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* brand glow backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{ backgroundImage: 'var(--gradient-brand)' }}
      />
      <form
        data-testid="token-gate-form"
        className="relative w-full max-w-md space-y-5 rounded-2xl border border-edge bg-panel p-8 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          if (entered.trim()) props.onSubmit(entered.trim())
        }}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandIcon size={40} />
          <div>
            <h1 className="text-brand-gradient text-2xl font-semibold tracking-tight">caduceus</h1>
            <p className="mt-1 text-xs text-ink-dim">multi-agent operations console</p>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-ink-dim">
          Enter the admin token. The easy way: run <code className="font-mono">caduceus ui</code> —
          it opens this page with the token attached. Manually, it lives at{' '}
          <code className="font-mono">~/.caduceus/admin.token</code>.
        </p>
        {props.invalid && (
          <p
            data-testid="token-gate-error"
            className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad"
          >
            The daemon rejected that token (401). Check it and try again.
          </p>
        )}
        <label className="relative block">
          <KeyRound
            size={14}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
          />
          <input
            data-testid="token-gate-input"
            type="password"
            autoFocus
            className={`${INPUT_MONO_CLASS} pl-9`}
            placeholder="admin token"
            value={entered}
            onChange={(e) => setEntered(e.target.value)}
          />
        </label>
        <Button
          variant="gradient"
          size="md"
          testId="token-gate-submit-button"
          type="submit"
          disabled={!entered.trim()}
          className="w-full"
        >
          Connect
        </Button>
      </form>
    </div>
  )
}
