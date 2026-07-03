/** Admin-token bootstrap (Q1=A / U4-SEC-3).
 *
 * `caduceus ui` opens the SPA with `#token=…`; the fragment never reaches the
 * server. It is stored and immediately stripped from the address bar. Manual
 * entry is the fallback. A 401 marks the token invalid but keeps it in the
 * input for correction (W3).
 */

const TOKEN_KEY = 'caduceus.token'

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // storage unavailable — token stays in memory for this session
  }
}

/** Parse `#token=…` and return the token, if present. Pure over the input. */
export function tokenFromHash(hash: string): string | null {
  const match = /^#token=([^&]+)$/.exec(hash)
  if (!match || !match[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** Consume the fragment: store the token and scrub the address bar. */
export function consumeFragmentToken(): string | null {
  const token = tokenFromHash(window.location.hash)
  if (!token) return null
  saveToken(token)
  history.replaceState(null, '', window.location.pathname + window.location.search)
  return token
}
