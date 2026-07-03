/** Brand marks, inlined from assets/ (logo.svg gradient identity) so no
 * network fetch is needed. `BrandIcon` is the ">" glyph; `BrandWordmark`
 * pairs it with the name set in the UI font. */

import type { ReactNode } from 'react'

export function BrandIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 24
  return (
    <svg width={size} height={size} viewBox="0 0 954 954" aria-hidden>
      <defs>
        <linearGradient
          id="brand-g"
          gradientUnits="userSpaceOnUse"
          x1="120"
          y1="120"
          x2="834"
          y2="834"
        >
          <stop offset="0" stopColor="#56b3fa" />
          <stop offset="0.5" stopColor="#7c6cf0" />
          <stop offset="1" stopColor="#cf63ee" />
        </linearGradient>
      </defs>
      <path
        d="M235,220 L595,470 L235,720"
        fill="none"
        stroke="url(#brand-g)"
        strokeWidth="130"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BrandWordmark(props: { iconSize?: number; textClass?: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandIcon size={props.iconSize ?? 22} />
      <span
        className={`text-brand-gradient font-semibold tracking-tight ${props.textClass ?? 'text-lg'}`}
      >
        caduceus
      </span>
    </span>
  )
}
