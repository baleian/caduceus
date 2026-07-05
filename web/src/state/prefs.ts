/** UiPrefs (Q5 revised by redesign Q1=A): theme dark-by-default + thinking
 * collapse + sidebar collapse. The only persisted client state besides the
 * admin token (U4-REL-5). */

export type ThemePref = 'system' | 'dark' | 'light'

export interface UiPrefs {
  theme: ThemePref
  thinkingOpen: boolean
  sidebarCollapsed: boolean
  /** Last agent opened in Chat — lets /chat resume the last conversation. */
  lastChatAgent: string | null
}

const PREFS_KEY = 'caduceus.prefs'

export const defaultPrefs: UiPrefs = {
  theme: 'dark',
  thinkingOpen: false,
  sidebarCollapsed: false,
  lastChatAgent: null,
}

export function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return defaultPrefs
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      theme:
        parsed.theme === 'dark' || parsed.theme === 'light' || parsed.theme === 'system'
          ? parsed.theme
          : 'dark',
      thinkingOpen: parsed.thinkingOpen === true,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      lastChatAgent: typeof parsed.lastChatAgent === 'string' ? parsed.lastChatAgent : null,
    }
  } catch {
    return defaultPrefs
  }
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable — prefs stay session-local
  }
}

export function isDark(pref: ThemePref, systemDark: boolean): boolean {
  if (pref === 'dark') return true
  if (pref === 'light') return false
  return systemDark
}

export function applyTheme(prefs: UiPrefs): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', isDark(prefs.theme, systemDark))
}
