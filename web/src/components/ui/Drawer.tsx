/** Right-hand slide-over: create/edit flows keep the page context visible
 * (redesign P5). Escape or overlay click closes. */

import { X } from 'lucide-react'
import { useEffect, useId, type ReactNode } from 'react'

export function Drawer(props: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId?: string
}): ReactNode {
  const titleId = useId()

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  if (!props.open) return null
  return (
    <div className="fixed inset-0 z-40" data-testid={props.testId}>
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={props.onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-edge bg-panel shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold">
            {props.title}
          </h2>
          <button
            type="button"
            aria-label="close"
            className="rounded-lg p-1.5 text-ink-dim hover:bg-panel-2 hover:text-ink"
            onClick={props.onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{props.children}</div>
        {props.footer && (
          <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">{props.footer}</div>
        )}
      </div>
    </div>
  )
}
