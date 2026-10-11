import Link from 'next/link'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { ProjectRef } from './types'

/**
 * A subject's Cairn project: the project's own mark and its key. With `href`
 * it is a link to the project, for places where nothing else is clickable.
 */
export const ProjectLabel = ({
  project,
  href,
  className,
}: {
  project: Pick<ProjectRef, 'key' | 'title'>
  href?: string
  className?: string
}) => {
  const classes = cn('text-fg-muted inline-flex min-w-0 items-center gap-1.5 text-meta', className)
  const content = (
    <>
      <ProjectIcon size={12} projectKey={project.key} />
      <span className="truncate font-mono">{project.key}</span>
    </>
  )
  return href ? (
    <Link href={href} className={cn(classes, 'hover:text-fg transition-colors')} title={project.title}>
      {content}
    </Link>
  ) : (
    <span className={classes} title={project.title}>
      {content}
    </span>
  )
}
