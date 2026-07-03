/** Visibility-aware polling (WPT-8/U4-PERF-5): runs only while mounted,
 * enabled, and the document is visible. The single polling primitive —
 * no scattered setInterval. */

import { useEffect, useRef } from 'react'

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
): void {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer === null && document.visibilityState === 'visible') {
        void fnRef.current()
        timer = setInterval(() => void fnRef.current(), intervalMs)
      }
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())

    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, enabled])
}
