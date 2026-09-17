export const USER_ROLES = ['admin', 'member'] as const
export type UserRole = (typeof USER_ROLES)[number]
export type ActorType = 'human' | 'agent'

export const actorLabel = (
  actorType: ActorType,
  actorId: string,
  userDisplayName: string | null,
): string => {
  const owner = userDisplayName?.trim()
  if (actorType === 'human') return owner || actorId
  if (!owner) return actorId
  const suffix = ` · ${owner}`
  return actorId.endsWith(suffix) ? actorId : `${actorId}${suffix}`
}

export const canAdministerUsers = (actor: { actorType: ActorType; role: UserRole }): boolean =>
  actor.actorType === 'human' && actor.role === 'admin'
