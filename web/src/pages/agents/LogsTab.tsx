/** Logs tab (Q8=A): snapshot + follow toggle. Follow is a visibility-aware
 * 1.5s poll deduped through lib/tail (PU4-6); a lost overlap renders a gap
 * marker — never a silent skip. */

import { useCallback, useRef, useState, type ReactNode } from 'react'

import { redact } from '../../lib/redact'
import { advance } from '../../lib/tail'
import { useApp } from '../../state/AppStore'
import { usePolling } from '../../state/usePolling'

const SNAPSHOT_LINES = 200
const GAP_MARKER = '——— gap: log rotated or output outran the window ———'

export function LogsTab(props: { agent: string }): ReactNode {
  const { client } = useApp()
  const [lines, setLines] = useState<string[]>([])
  const [follow, setFollow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prevSnapshot = useRef<string[]>([])
  const scrollRef = useRef<HTMLPreElement>(null)

  const fetchSnapshot = useCallback(
    async (mode: 'replace' | 'append') => {
      try {
        const { lines: fetched } = await client.logs(props.agent, SNAPSHOT_LINES)
        setError(null)
        if (mode === 'replace') {
          prevSnapshot.current = fetched
          setLines(fetched)
        } else {
          const step = advance(prevSnapshot.current, fetched)
          prevSnapshot.current = fetched
          if (step.newLines.length > 0 || step.gap) {
            setLines((existing) => [
              ...existing,
              ...(step.gap ? [GAP_MARKER] : []),
              ...step.newLines,
            ])
            queueMicrotask(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
            })
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'failed to fetch logs')
      }
    },
    [client, props.agent],
  )

  usePolling(() => fetchSnapshot('append'), 1_500, follow)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <button
          data-testid="logs-refresh-button"
          className="rounded border border-edge px-3 py-1 text-sm hover:bg-panel"
          onClick={() => void fetchSnapshot('replace')}
        >
          Refresh
        </button>
        <label className="flex items-center gap-1.5 text-sm text-ink-dim">
          <input
            data-testid="logs-follow-toggle"
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          follow
        </label>
        {error && <span className="text-sm text-bad">{error}</span>}
      </div>
      <pre
        ref={scrollRef}
        data-testid="logs-output"
        className="h-96 overflow-auto rounded border border-edge bg-panel p-3 font-mono text-xs leading-5"
      >
        {lines.length === 0
          ? '(no log lines — press Refresh)'
          : lines.map((line) => redact(line, 4000)).join('\n')}
      </pre>
    </div>
  )
}
