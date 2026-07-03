import { Search } from 'lucide-react'
import type { ReactNode } from 'react'

export function SearchInput(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
}): ReactNode {
  return (
    <label className="relative block">
      <Search
        size={14}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
      />
      <input
        data-testid={props.testId}
        type="search"
        className="w-56 rounded-lg border border-edge bg-panel py-1.5 pr-3 pl-8 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none"
        placeholder={props.placeholder ?? 'Search…'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  )
}
