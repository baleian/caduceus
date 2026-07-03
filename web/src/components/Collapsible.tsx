import { useState, type ReactNode } from 'react'

export function Collapsible(props: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  testId?: string
}): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <div className="rounded border border-edge">
      <button
        type="button"
        data-testid={props.testId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-ink-dim">{open ? '▾' : '▸'}</span>
        {props.summary}
      </button>
      {open && <div className="border-t border-edge px-3 py-2">{props.children}</div>}
    </div>
  )
}
