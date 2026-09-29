'use client'

import { createContext, useContext } from 'react'
import type { Person } from '@/lib/api/people'

/**
 * Everyone a task can be assigned to, plus who is asking — fetched once in
 * the layout so every assignee picker (the create dialog, the sidebar, list
 * rows, the boards) shares one list instead of each fetching its own.
 */
const PeopleContext = createContext<{ people: Person[]; currentUserId: string }>({
  people: [],
  currentUserId: '',
})

export const PeopleProvider = ({
  people,
  currentUserId,
  children,
}: {
  people: Person[]
  currentUserId: string
  children: React.ReactNode
}) => (
  <PeopleContext.Provider value={{ people, currentUserId }}>{children}</PeopleContext.Provider>
)

export const usePeople = () => useContext(PeopleContext)
