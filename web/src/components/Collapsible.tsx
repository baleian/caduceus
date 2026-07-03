import { ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function Collapsible(props: {
  summary: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  testId?: string
}): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <div className="rounded-lg border border-edge">
      <button
        type="button"
        data-testid={props.testId}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-panel-2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {props.summary}
      </button>
      {open && <div className="border-t border-edge px-3 py-2">{props.children}</div>}
    </div>
  )
}
