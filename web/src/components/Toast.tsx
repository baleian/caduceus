import { AlertTriangle, Info, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'

import { useApp } from '../state/AppStore'

const TONE = {
  info: { border: 'border-accent/50', icon: Info, iconClass: 'text-accent' },
  warn: { border: 'border-warn/50', icon: AlertTriangle, iconClass: 'text-warn' },
  error: { border: 'border-bad/50', icon: XCircle, iconClass: 'text-bad' },
} as const

export function ToastArea(): ReactNode {
  const { state, dismissToast } = useApp()
  if (state.toasts.length === 0) return null
  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" data-testid="toast-area">
      {state.toasts.map((toast) => {
        const tone = TONE[toast.tone]
        const Icon = tone.icon
        return (
          <button
            key={toast.id}
            onClick={() => dismissToast(toast.id)}
            className={`flex max-w-sm items-start gap-2.5 rounded-xl border ${tone.border} bg-panel px-3.5 py-2.5 text-left text-sm shadow-lg shadow-black/20`}
          >
            <Icon size={15} className={`mt-0.5 shrink-0 ${tone.iconClass}`} aria-hidden />
            <span className="min-w-0 break-words">{toast.text}</span>
          </button>
        )
      })}
    </div>
  )
}
