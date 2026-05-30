export type Plan = 'FREE' | 'PRO'

export interface PlanLimits {
  transactionsPerMonth: number | null  // null = unlimited
  bills:                number | null
  goals:                number | null
  people:               number | null
  customCategories:     number | null
  recurring:            number | null
  budget:               boolean
  reports:              boolean
  projection:           boolean
  import:               boolean
  chat:                 number | null  // msgs/month, null = unlimited
  scanner:              number | null  // scans/month
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: {
    transactionsPerMonth: 50,
    bills:                5,
    goals:                2,
    people:               2,
    customCategories:     3,
    recurring:            2,
    budget:               false,
    reports:              false,
    projection:           false,
    import:               false,
    chat:                 null,  // blocked entirely
    scanner:              null,  // blocked entirely
  },
  PRO: {
    transactionsPerMonth: null,
    bills:                null,
    goals:                null,
    people:               null,
    customCategories:     null,
    recurring:            null,
    budget:               true,
    reports:              true,
    projection:           true,
    import:               true,
    chat:                 30,
    scanner:              20,
  },
}

export function getLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.FREE
}
