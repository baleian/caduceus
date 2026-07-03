/** The single confirmation gate for destructive operations (WPT-11/W1).
 *
 * Two variants: `typed` requires re-typing the target name (agent removal);
 * `simple` is a plain confirm (session delete, token rotate). The confirm
 * callback receives the typed name — X-Confirm headers are built from it and
 * nowhere else. */

import { AlertTriangle } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Button } from './ui/Button'
import { INPUT_MONO_CLASS } from './ui/Field'

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-edge bg-panel p-5 shadow-2xl"
      >
        <div className="mb-2 flex items-center gap-2.5">
          {props.destructive && (
            <span className="rounded-lg bg-bad/10 p-1.5 text-bad">
              <AlertTriangle size={16} aria-hidden />
            </span>
          )}
          <h2 id={titleId} className="text-base font-semibold">
            {props.title}
          </h2>
        </div>
        <div className="mb-4 text-sm leading-relaxed text-ink-dim">{props.body}</div>
        {props.typedName !== undefined && (
          <input
            ref={inputRef}
            data-testid="confirm-modal-name-input"
            className={`mb-4 ${INPUT_MONO_CLASS}`}
            placeholder={`type "${props.typedName}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" testId="confirm-modal-cancel-button" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant={props.destructive ? 'danger' : 'primary'}
            testId="confirm-modal-confirm-button"
            disabled={!armed}
            onClick={() => armed && props.onConfirm(typed)}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
