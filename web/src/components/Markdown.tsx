/** Assistant-message markdown (redesign §6.4): GFM + syntax highlighting.
 * Raw HTML is NOT rendered (react-markdown default) so the XSS surface stays
 * closed; callers pass already-redacted text (security invariant). */

import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

export function Markdown(props: { text: string }): ReactNode {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {props.text}
      </ReactMarkdown>
    </div>
  )
}
