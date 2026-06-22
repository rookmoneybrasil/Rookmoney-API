export type Plan = 'FREE' | 'PRO' | 'PRO_PLUS'

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
  chatFiles:            number | null  // file uploads in chat/month
  chatAnalysis:         number | null  // analyze_finances calls/month
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
    chatFiles:            null,
    chatAnalysis:         null,
    scanner:              null,
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
    chatFiles:            10,
    chatAnalysis:         4,
    scanner:              20,
  },
  PRO_PLUS: {
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
    chat:                 null,  // unlimited
    chatFiles:            null,  // unlimited
    chatAnalysis:         null,  // unlimited
    scanner:              null,  // unlimited
  },
}

export function isPro(plan?: string | null) {
  return plan === 'PRO' || plan === 'PRO_PLUS'
}

export function isProPlus(plan?: string | null) {
  return plan === 'PRO_PLUS'
}

export function getLimits(plan?: string | null): PlanLimits {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.FREE
}

export function usagePercent(used: number, limit: number | null): number {
  if (limit === null) return 0
  return Math.min(Math.round((used / limit) * 100), 100)
}
