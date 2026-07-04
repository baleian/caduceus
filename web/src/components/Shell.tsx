/** App chrome, redesigned (plan §4): fixed left sidebar — brand, icon nav,
 * daemon connection + theme at the bottom — with a full-bleed content area
 * sized for 16:9 desktops. Collapse state persists in prefs. Chat routes get
 * a full-height, no-scroll main so the conversation manages its own scroll. */

import {
  Bot,
  LayoutDashboard,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sun,
  Telescope,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { useApp } from '../state/AppStore'
import { applyTheme, loadPrefs, savePrefs, type ThemePref } from '../state/prefs'
import { BrandIcon } from './Brand'
import { ToastArea } from './Toast'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/observability', label: 'Observability', icon: Telescope },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/gateway', label: 'Gateway', icon: Network },
  { to: '/system', label: 'System', icon: Settings2 },
]

const CONNECTION_TONE = {
  connected: 'bg-ok',
  reconnecting: 'bg-warn',
  down: 'bg-bad',
} as const

const THEME_ORDER: ThemePref[] = ['dark', 'light', 'system']
const THEME_ICON = { dark: Moon, light: Sun, system: Monitor } as const

export function Shell(): ReactNode {
  const { state } = useApp()
  const [theme, setTheme] = useState<ThemePref>(() => loadPrefs().theme)
  const [collapsed, setCollapsed] = useState(() => loadPrefs().sidebarCollapsed)
  const location = useLocation()
  // conversation view manages its own scroll; everything else scrolls the main
  const fullHeight = /^\/chat\/./.test(location.pathname)

  function cycleTheme(): void {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!
    const prefs = { ...loadPrefs(), theme: next }
    savePrefs(prefs)
    applyTheme(prefs)
    setTheme(next)
  }

  function toggleCollapsed(): void {
    const next = !collapsed
    savePrefs({ ...loadPrefs(), sidebarCollapsed: next })
    setCollapsed(next)
  }

  const ThemeIcon = THEME_ICON[theme]

  return (
    <div className="flex h-screen">
      <aside
        className={`flex shrink-0 flex-col border-r border-edge bg-panel transition-[width] duration-150 ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        <div
          className={`flex h-14 items-center border-b border-edge ${collapsed ? 'justify-center' : 'gap-2.5 px-4'}`}
        >
          <BrandIcon size={22} />
          {!collapsed && (
            <span className="text-brand-gradient text-lg font-semibold tracking-tight">
              caduceus
            </span>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {NAV.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                data-testid={`nav-${item.label.toLowerCase()}-link`}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `flex items-center rounded-lg text-sm transition-colors ${
                    collapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2'
                  } ${
                    isActive
                      ? 'bg-accent/12 font-medium text-accent'
                      : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
                  }`
                }
              >
                <Icon size={17} strokeWidth={2} aria-hidden />
                {!collapsed && item.label}
              </NavLink>
            )
          })}
        </nav>

        <div
          className={`space-y-2 border-t border-edge p-3 ${collapsed ? 'flex flex-col items-center' : ''}`}
        >
          <span
            data-testid="shell-connection-badge"
            className={`flex items-center gap-2 text-xs text-ink-dim ${collapsed ? 'justify-center' : 'px-1'}`}
            title={`daemon events: ${state.connection}`}
          >
            <span className={`h-2 w-2 rounded-full ${CONNECTION_TONE[state.connection]}`} />
            {!collapsed && state.connection}
          </span>
          <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
            <button
              data-testid="shell-theme-toggle-button"
              onClick={cycleTheme}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-ink-dim hover:bg-panel-2 hover:text-ink"
              title={`theme: ${theme}`}
            >
              <ThemeIcon size={15} aria-hidden />
              {!collapsed && theme}
            </button>
            <button
              onClick={toggleCollapsed}
              className="rounded-lg px-2 py-1.5 text-ink-dim hover:bg-panel-2 hover:text-ink"
              title={collapsed ? 'expand sidebar' : 'collapse sidebar'}
              aria-label={collapsed ? 'expand sidebar' : 'collapse sidebar'}
            >
              {collapsed ? (
                <PanelLeftOpen size={15} aria-hidden />
              ) : (
                <PanelLeftClose size={15} aria-hidden />
              )}
            </button>
          </div>
        </div>
      </aside>

      <main className={`min-w-0 flex-1 ${fullHeight ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        <div className={fullHeight ? 'h-full' : 'px-8 py-6'}>
          <Outlet />
        </div>
      </main>
      <ToastArea />
    </div>
  )
}
