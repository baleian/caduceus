/** App chrome: nav (4 sections — Q2=A), daemon connection badge, theme toggle. */

import { useState, type ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

import { useApp } from '../state/AppStore'
import { applyTheme, loadPrefs, savePrefs, type ThemePref } from '../state/prefs'
import { ToastArea } from './Toast'

const NAV = [
  { to: '/agents', label: 'Agents' },
  { to: '/chat', label: 'Chat' },
  { to: '/gateway', label: 'Gateway' },
  { to: '/system', label: 'System' },
]

const CONNECTION_TONE = {
  connected: 'bg-ok',
  reconnecting: 'bg-warn',
  down: 'bg-bad',
} as const

const THEME_ORDER: ThemePref[] = ['system', 'dark', 'light']

export function Shell(): ReactNode {
  const { state } = useApp()
  const [theme, setTheme] = useState<ThemePref>(() => loadPrefs().theme)

  function cycleTheme(): void {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!
    const prefs = { ...loadPrefs(), theme: next }
    savePrefs(prefs)
    applyTheme(prefs)
    setTheme(next)
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-edge bg-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2.5">
          <span className="text-base font-semibold tracking-tight">☤ Caduceus</span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                data-testid={`nav-${item.label.toLowerCase()}-link`}
                className={({ isActive }) =>
                  `rounded px-3 py-1 text-sm ${
                    isActive
                      ? 'bg-accent/15 text-accent-strong font-medium'
                      : 'text-ink-dim hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <button
              data-testid="shell-theme-toggle-button"
              onClick={cycleTheme}
              className="rounded border border-edge px-2 py-0.5 text-xs text-ink-dim hover:text-ink"
              title="theme"
            >
              {theme}
            </button>
            <span
              data-testid="shell-connection-badge"
              className="flex items-center gap-1.5 text-xs text-ink-dim"
              title={`daemon events: ${state.connection}`}
            >
              <span className={`h-2 w-2 rounded-full ${CONNECTION_TONE[state.connection]}`} />
              {state.connection}
            </span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <ToastArea />
    </div>
  )
}
