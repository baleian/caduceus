/** Logs tab (Q8=A): snapshot + follow toggle. Auto-loads the snapshot on tab
 * enter (no forced manual Refresh into a blank void). Follow is a
 * visibility-aware 1.5s poll deduped through lib/tail (PU4-6); a lost overlap
 * renders a gap marker — never a silent skip. */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '../../components/ui/Button'
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
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const prevSnapshot = useRef<string[]>([])
  const scrollRef = useRef<HTMLPreElement>(null)

  const fetchSnapshot = useCallback(
    async (mode: 'replace' | 'append') => {
      try {
        const { lines: fetched } = await client.logs(props.agent, SNAPSHOT_LINES)
        setError(null)
        setLoaded(true)
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

  // auto-load the snapshot when the tab mounts (no blank giant box)
  useEffect(() => {
    void fetchSnapshot('replace')
  }, [fetchSnapshot])

  usePolling(() => fetchSnapshot('append'), 1_500, follow)

  const empty = lines.length === 0

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          testId="logs-refresh-button"
          onClick={() => void fetchSnapshot('replace')}
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </Button>
        <label className="flex items-center gap-1.5 text-sm text-ink-dim">
          <input
            data-testid="logs-follow-toggle"
            type="checkbox"
            className="accent-accent"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          follow
          {follow && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden />}
        </label>
        {error && <span className="text-sm text-bad">{error}</span>}
        {!empty && (
          <span className="ml-auto text-xs text-ink-faint tabular-nums">{lines.length} lines</span>
        )}
      </div>
      <pre
        ref={scrollRef}
        data-testid="logs-output"
        className={`overflow-auto rounded-xl border border-edge bg-panel p-4 font-mono text-xs leading-5 text-ink-dim ${
          empty ? 'flex h-40 items-center justify-center' : 'h-[70vh]'
        }`}
      >
        {empty
          ? loaded
            ? 'no log output yet'
            : 'loading logs…'
          : lines.map((line) => redact(line, 4000)).join('\n')}
      </pre>
    </div>
  )
}
