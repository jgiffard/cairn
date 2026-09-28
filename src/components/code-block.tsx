'use client'

import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A fenced code block with its language named and a copy button.
 *
 * Agent-written bodies are mostly code, commands and log excerpts, and the
 * single most common thing anyone does with them is copy one out. Without
 * this you select by hand across a scrolling region and usually catch the
 * wrong lines.
 */
export const CodeBlock = ({ children, ...rest }: React.ComponentProps<'pre'>) => {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  // react-markdown nests <code class="language-x"> inside <pre>; the language
  // lives on the child, not here.
  const child = Array.isArray(children) ? children[0] : children
  const className: string =
    (child as { props?: { className?: string } })?.props?.className ?? ''
  const language = /language-([\w-]+)/.exec(className)?.[1]

  const copy = async () => {
    const text = ref.current?.innerText ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard blocked; the selection still works
    }
  }

  return (
    // A card with its own lit edge: the accent catches the top rim faintly,
    // the way light catches the edge of anything raised on this canvas.
    <div className="group surface-card relative mb-3 overflow-hidden last:mb-0">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_oklab,var(--accent)_35%,transparent)_30%,color-mix(in_oklab,var(--accent)_35%,transparent)_70%,transparent)]"
      />
      <div className="border-border/60 bg-surface-raised/40 flex h-[1.75rem] items-center gap-2 border-b px-2.5">
        <span className="text-fg-subtle font-mono text-[0.65625rem] tracking-wide">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className={cn(
            'hover:bg-surface-hover -mr-1 ml-auto flex h-5 items-center gap-1 rounded px-1.5 text-[0.65625rem]',
            'opacity-0 transition-[opacity,color,background-color] duration-[var(--dur-1)] ease-[var(--ease-out)] group-hover:opacity-100 focus-visible:opacity-100',
            copied ? 'text-accent opacity-100' : 'text-fg-subtle hover:text-fg',
          )}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 text-[0.78125rem] leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
}
