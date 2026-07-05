/** Server-authoritative status chip (WPT-12): renders the synthesized values
 * verbatim — no client-side re-derivation. Dot + label so state is scannable
 * at a glance (never color alone). An optional `label` humanizes the caption on
 * NON-contract call sites; `value` still drives the tone and is the default
 * caption. The E2E asserts exact text on the process badges — never pass
 * `label` to agent-detail-process-badge / agents-row-*-process-badge. */

import type { ReactNode } from 'react'

const TONE: Record<string, { chip: string; dot: string; pulse?: boolean }> = {
  running: { chip: 'bg-ok/10 text-ok border-ok/20', dot: 'bg-ok', pulse: true },
  healthy: { chip: 'bg-ok/10 text-ok border-ok/20', dot: 'bg-ok' },
  ok: { chip: 'bg-ok/10 text-ok border-ok/20', dot: 'bg-ok' },
  done: { chip: 'bg-ok/10 text-ok border-ok/20', dot: 'bg-ok' },
  starting: { chip: 'bg-warn/10 text-warn border-warn/20', dot: 'bg-warn', pulse: true },
  stopping: { chip: 'bg-warn/10 text-warn border-warn/20', dot: 'bg-warn', pulse: true },
  stopped: { chip: 'bg-ink-dim/10 text-ink-dim border-edge', dot: 'bg-ink-faint' },
  'not-running': { chip: 'bg-ink-dim/10 text-ink-dim border-edge', dot: 'bg-ink-faint' },
  degraded: { chip: 'bg-warn/10 text-warn border-warn/20', dot: 'bg-warn' },
  failed: { chip: 'bg-bad/10 text-bad border-bad/20', dot: 'bg-bad' },
  error: { chip: 'bg-bad/10 text-bad border-bad/20', dot: 'bg-bad' },
  unhealthy: { chip: 'bg-bad/10 text-bad border-bad/20', dot: 'bg-bad' },
  unreachable: { chip: 'bg-warn/10 text-warn border-warn/20', dot: 'bg-warn' },
  unknown: { chip: 'bg-ink-dim/10 text-ink-dim border-edge', dot: 'bg-ink-faint' },
}

const FALLBACK = { chip: 'bg-ink-dim/10 text-ink-dim border-edge', dot: 'bg-ink-faint', pulse: false }

export function StatusBadge(props: { value: string; label?: ReactNode; testId?: string }): ReactNode {
  const tone = TONE[props.value] ?? FALLBACK
  return (
    <span
      data-testid={props.testId}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone.chip}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${tone.pulse ? 'animate-pulse' : ''}`}
      />
      {props.label ?? props.value}
    </span>
  )
}
