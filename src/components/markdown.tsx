'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'
import { cn } from '@/lib/utils'
import { CodeBlock } from '@/components/code-block'
import { useProjectKeys } from '@/components/project-keys'
import { useKnowledgeSlugs } from '@/components/knowledge-slugs'
import { remarkTaskRefs } from '@/lib/markdown/task-refs'
import { remarkKnowledgeRefs } from '@/lib/markdown/knowledge-refs'

/**
 * A hand-rolled component map rather than a prose plugin, so every element
 * inherits the same oklch tokens as the rest of the app and stays legible at
 * the density a tracker needs.
 */
const components: Components = {
  h1: (p) => <h1 className="mt-6 mb-2 text-lg font-semibold tracking-tight first:mt-0" {...p} />,
  h2: (p) => <h2 className="mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0" {...p} />,
  h3: (p) => <h3 className="text-fg-muted mt-4 mb-1.5 text-sm font-semibold first:mt-0" {...p} />,
  p: (p) => <p className="mb-3 text-sm leading-relaxed last:mb-0" {...p} />,
  ul: (p) => <ul className="mb-3 ml-4 list-disc space-y-1 text-sm last:mb-0" {...p} />,
  ol: (p) => <ol className="mb-3 ml-4 list-decimal space-y-1 text-sm last:mb-0" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  a: ({ href, children, ...rest }) => {
    // A linkified task ref is in-app navigation, not an outbound link: opening
    // it in a new tab would make following a chain of references unbearable.
    const knowledgeRef = (rest as Record<string, unknown>)['data-knowledge-ref']
    if (typeof knowledgeRef === 'string' && href) {
      // Marked when the target does not exist, so a reference to something
      // nobody wrote reads as a loose end rather than as a working link.
      const missing = (rest as Record<string, unknown>)['data-knowledge-missing'] === 'true'
      return (
        <Link
          href={href}
          prefetch={!missing}
          title={missing ? `No knowledge "${knowledgeRef}" — yet` : undefined}
          className={
            missing
              ? 'text-fg-subtle decoration-dotted underline underline-offset-2'
              : 'text-accent decoration-1 underline-offset-2 hover:underline'
          }
        >
          {children}
        </Link>
      )
    }

    const taskRef = (rest as Record<string, unknown>)['data-task-ref']
    if (typeof taskRef === 'string' && href) {
      return (
        <Link
          href={href}
          prefetch
          className="text-accent decoration-1 underline-offset-2 hover:underline"
        >
          {children}
        </Link>
      )
    }
    return (
      <a
        href={href}
        className="text-accent underline decoration-1 underline-offset-2"
        target="_blank"
        rel="noreferrer noopener"
        {...rest}
      >
        {children}
      </a>
    )
  },
  blockquote: (p) => (
    <blockquote className="border-border text-fg-muted mb-3 border-l-2 pl-3 text-sm italic" {...p} />
  ),
  hr: () => <hr className="border-border my-4" />,
  strong: (p) => <strong className="font-semibold" {...p} />,
  code: ({ className, children, ...rest }) => {
    // react-markdown gives fenced blocks a language-* class; bare inline code
    // has none, and the two want very different treatment.
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className={cn('font-mono text-[0.8125rem] leading-relaxed', className)} {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="bg-surface-raised border-border rounded border px-1 py-px font-mono text-[0.78125rem]"
        {...rest}
      >
        {children}
      </code>
    )
  },
  pre: (p) => <CodeBlock {...p} />,
  table: (p) => (
    // Its own scroll container, so a wide table never makes the page body
    // scroll sideways.
    <div className="border-border mb-3 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-[0.78125rem]" {...p} />
    </div>
  ),
  th: (p) => (
    <th
      className="border-border bg-surface-raised text-fg-muted border-b px-2.5 py-1.5 text-left text-[0.6875rem] font-medium"
      {...p}
    />
  ),
  td: (p) => (
    <td className="border-border border-b px-2.5 py-1.5 align-top last:border-0" {...p} />
  ),
  input: (p) => (
    // GFM task list checkboxes. Read-only here: the body is edited in the
    // editor, not by clicking through the rendered view.
    <input
      className="accent-accent mr-1.5 translate-y-[1px]"
      disabled
      readOnly
      {...p}
    />
  ),
  img: (p) => (
    // next/image is not usable here: these URLs come from markdown an agent
    // wrote, so the host is arbitrary and cannot be pre-declared in
    // next.config, and signed attachment URLs are short-lived and unoptimisable.
    // eslint-disable-next-line @next/next/no-img-element
    <img className="border-border my-3 max-w-full rounded-md border" alt="" {...p} />
  ),
}

export const MarkdownView = ({ children }: { children: string }) => {
  const keys = useProjectKeys()
  // Only where the COMPLETE set of slugs is in hand. Given a partial list the
  // plugin would mark every entry missing from it as never written, so the
  // provider's default is null and this stays off rather than lying.
  const slugs = useKnowledgeSlugs()
  // react-markdown re-parses whenever the plugin array changes identity, so
  // this must not be rebuilt on every render.
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkGfm,
      [remarkTaskRefs, { keys }],
      [remarkKnowledgeRefs, slugs ? { known: slugs } : {}],
    ],
    [keys, slugs],
  )

  return (
    <div className="text-fg">
      <Markdown
        remarkPlugins={remarkPlugins}
        // detect: false — only highlight blocks that declare a language.
        // Guessing on an unlabelled block colours prose and log output as if it
        // were code, which is worse than leaving it plain.
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  )
}

/**
 * Three-line clamped preview for cards and list rows. Renders the markdown
 * rather than showing raw syntax, then clamps — which is what makes a board of
 * agent-written tasks scannable.
 */
export const MarkdownPreview = ({ children, lines = 3 }: { children: string; lines?: number }) => (
  <div
    className="text-fg-muted overflow-hidden text-[0.78125rem] leading-snug [&_*]:!mb-0 [&_*]:!mt-0 [&_a]:no-underline [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_h1]:text-[0.78125rem] [&_h1]:font-normal [&_h2]:text-[0.78125rem] [&_h2]:font-normal [&_h3]:text-[0.78125rem] [&_h3]:font-normal [&_li]:list-none [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_ul]:ml-0"
    style={{
      display: '-webkit-box',
      WebkitLineClamp: lines,
      WebkitBoxOrient: 'vertical',
    }}
  >
    <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
  </div>
)
