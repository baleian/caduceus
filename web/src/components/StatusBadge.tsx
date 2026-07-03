/** Server-authoritative status chip (WPT-12): renders the synthesized values
 * verbatim — no client-side re-derivation. */

const TONE: Record<string, string> = {
  running: 'bg-ok/15 text-ok',
  healthy: 'bg-ok/15 text-ok',
  stopped: 'bg-ink-dim/15 text-ink-dim',
  'not-running': 'bg-ink-dim/15 text-ink-dim',
  failed: 'bg-bad/15 text-bad',
  unhealthy: 'bg-bad/15 text-bad',
  unreachable: 'bg-warn/15 text-warn',
  unknown: 'bg-ink-dim/10 text-ink-dim',
}

export function StatusBadge(props: { value: string; testId?: string }): React.ReactNode {
  const tone = TONE[props.value] ?? 'bg-ink-dim/10 text-ink-dim'
  return (
    <span
      data-testid={props.testId}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}
    >
      {props.value}
    </span>
  )
}
