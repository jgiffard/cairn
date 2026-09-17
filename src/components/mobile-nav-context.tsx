'use client'

import { createContext, useContext } from 'react'
import { MobileNav } from '@/components/mobile-nav'

/**
 * The hamburger belongs in each page's own header bar, not floating over the
 * content — but the layout is where the project list lives. This carries that
 * data down so any page header can drop the button into place.
 */
const MobileNavContext = createContext<{
  email: string
  role: 'admin' | 'member'
  projects: { key: string; title: string }[]
} | null>(null)

export const MobileNavProvider = ({
  email,
  role,
  projects,
  children,
}: {
  email: string
  role: 'admin' | 'member'
  projects: { key: string; title: string }[]
  children: React.ReactNode
}) => (
  <MobileNavContext.Provider value={{ email, role, projects }}>{children}</MobileNavContext.Provider>
)

/** Renders nothing on desktop; the hamburger on narrow screens. */
export const MobileNavButton = () => {
  const ctx = useContext(MobileNavContext)
  if (!ctx) return null
  return <MobileNav email={ctx.email} role={ctx.role} projects={ctx.projects} />
}
