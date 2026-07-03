import type { ReactNode } from 'react'

import { useApp } from '../state/AppStore'

const TONE = {
  info: 'border-accent text-ink',
  warn: 'border-warn text-warn',
  error: 'border-bad text-bad',
} as const

export function ToastArea(): ReactNode {
  const { state, dismissToast } = useApp()
  if (state.toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2" data-testid="toast-area">
      {state.toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismissToast(toast.id)}
          className={`max-w-sm rounded border-l-4 bg-panel px-3 py-2 text-left text-sm shadow-lg ${TONE[toast.tone]}`}
        >
          {toast.text}
        </button>
      ))}
    </div>
  )
}
