/** The single confirmation gate for destructive operations (WPT-11/W1).
 *
 * Two variants: `typed` requires re-typing the target name (agent removal);
 * `simple` is a plain confirm (session delete, token rotate). The confirm
 * callback receives the typed name — X-Confirm headers are built from it and
 * nowhere else. */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface ConfirmModalProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  /** when set, the user must type this exact value to enable confirm */
  typedName?: string
  destructive?: boolean
  onConfirm: (typed: string) => void
  onCancel: () => void
}

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (props.open) {
      setTyped('')
      inputRef.current?.focus()
    }
  }, [props.open])

  if (!props.open) return null
  const armed = props.typedName === undefined || typed === props.typedName

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-2 text-lg font-semibold">
          {props.title}
        </h2>
        <div className="mb-4 text-sm text-ink-dim">{props.body}</div>
        {props.typedName !== undefined && (
          <input
            ref={inputRef}
            data-testid="confirm-modal-name-input"
            className="mb-4 w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm"
            placeholder={`type "${props.typedName}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            data-testid="confirm-modal-cancel-button"
            className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-surface"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            data-testid="confirm-modal-confirm-button"
            disabled={!armed}
            className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${
              props.destructive ? 'bg-bad hover:opacity-90' : 'bg-accent-strong hover:opacity-90'
            }`}
            onClick={() => armed && props.onConfirm(typed)}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
