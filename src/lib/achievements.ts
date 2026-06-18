export type AchievementCategory =
  | 'onboarding'
  | 'organization'
  | 'payments'
  | 'goals'
  | 'volume'
  | 'financial'

export interface AchievementDef {
  slug:        string
  category:    AchievementCategory
  icon:        string
  /** Which action contexts can trigger this check */
  triggers:    string[]
}

// All 61 achievements — triggers define WHEN to check (not how).
// The actual check logic lives in achievement-checker.ts.

export const ACHIEVEMENTS: AchievementDef[] = [
  // ─── Onboarding (7) ──────────────────────────────────────────────
  { slug: 'welcome',            category: 'onboarding',    icon: '👋', triggers: ['register'] },
  { slug: 'first-account',      category: 'onboarding',    icon: '🏦', triggers: ['create-bill', 'create-transaction'] },
  { slug: 'first-income',       category: 'onboarding',    icon: '💰', triggers: ['create-income'] },
  { slug: 'first-bill',         category: 'onboarding',    icon: '📄', triggers: ['create-bill'] },
  { slug: 'first-goal',         category: 'onboarding',    icon: '🎯', triggers: ['create-goal'] },
  { slug: 'first-transaction',  category: 'onboarding',    icon: '💳', triggers: ['create-transaction'] },
  { slug: 'complete-profile',   category: 'onboarding',    icon: '🪪', triggers: ['update-profile'] },

  // ─── Organization (9) ────────────────────────────────────────────
  { slug: 'organized',          category: 'organization',  icon: '📁', triggers: ['create-bill', 'create-transaction'] },
  { slug: 'archivist',          category: 'organization',  icon: '🗄️', triggers: ['create-bill', 'create-transaction'] },
  { slug: 'autopilot',          category: 'organization',  icon: '🔁', triggers: ['create-recurring-bill'] },
  { slug: 'full-autopilot',     category: 'organization',  icon: '✈️', triggers: ['create-recurring-bill'] },
  { slug: 'split-right',        category: 'organization',  icon: '👥', triggers: ['create-person-entry'] },
  { slug: 'financial-network',  category: 'organization',  icon: '🕸️', triggers: ['create-person-entry', 'create-person'] },
  { slug: 'multi-income',       category: 'organization',  icon: '📈', triggers: ['create-income'] },
  { slug: 'diversified',        category: 'organization',  icon: '💹', triggers: ['create-income'] },
  { slug: 'full-panorama',      category: 'organization',  icon: '🗺️', triggers: ['create-bill', 'create-goal', 'create-income', 'create-transaction'] },

  // ─── Payments & Discipline (12) ──────────────────────────────────
  { slug: 'punctual',           category: 'payments',      icon: '⏰', triggers: ['pay-bill'] },
  { slug: 'super-punctual',     category: 'payments',      icon: '⚡', triggers: ['pay-bill'] },
  { slug: 'relentless',         category: 'payments',      icon: '🔥', triggers: ['pay-bill'] },
  { slug: 'punctuality-legend', category: 'payments',      icon: '⚔️', triggers: ['pay-bill'] },
  { slug: 'clean-month',        category: 'payments',      icon: '✅', triggers: ['pay-bill'] },
  { slug: 'perfect-quarter',    category: 'payments',      icon: '🏅', triggers: ['pay-bill'] },
  { slug: 'golden-semester',    category: 'payments',      icon: '👑', triggers: ['pay-bill'] },
  { slug: 'flawless-year',      category: 'payments',      icon: '💎', triggers: ['pay-bill'] },
  { slug: 'cleared-month',      category: 'payments',      icon: '🧹', triggers: ['pay-bill'] },
  { slug: 'lightning-payer',    category: 'payments',      icon: '⚡', triggers: ['pay-bill'] },
  { slug: 'ahead-of-time',      category: 'payments',      icon: '🏃', triggers: ['pay-bill'] },
  { slug: 'fortune-teller',     category: 'payments',      icon: '🔮', triggers: ['pay-bill'] },

  // ─── Goals & Savings (12) ────────────────────────────────────────
  { slug: 'first-deposit',      category: 'goals',         icon: '🌱', triggers: ['contribute-goal'] },
  { slug: 'steady',             category: 'goals',         icon: '💧', triggers: ['contribute-goal'] },
  { slug: 'dedicated',          category: 'goals',         icon: '🌊', triggers: ['contribute-goal'] },
  { slug: 'obsessive',          category: 'goals',         icon: '🌀', triggers: ['contribute-goal'] },
  { slug: 'halfway',            category: 'goals',         icon: '🛤️', triggers: ['contribute-goal'] },
  { slug: 'goal-reached',       category: 'goals',         icon: '🏆', triggers: ['contribute-goal'] },
  { slug: 'dream-collector',    category: 'goals',         icon: '⭐', triggers: ['contribute-goal'] },
  { slug: 'achiever',           category: 'goals',         icon: '🌟', triggers: ['contribute-goal'] },
  { slug: 'dream-machine',      category: 'goals',         icon: '🚀', triggers: ['contribute-goal'] },
  { slug: 'heavy-deposit',      category: 'goals',         icon: '💪', triggers: ['contribute-goal'] },
  { slug: 'monster-deposit',    category: 'goals',         icon: '🦍', triggers: ['contribute-goal'] },
  { slug: 'goal-millionaire',   category: 'goals',         icon: '🤑', triggers: ['contribute-goal'] },

  // ─── Volume & Engagement (11) ────────────────────────────────────
  { slug: '10-bills',           category: 'volume',        icon: '📋', triggers: ['create-bill'] },
  { slug: '50-bills',           category: 'volume',        icon: '📚', triggers: ['create-bill'] },
  { slug: '100-bills',          category: 'volume',        icon: '💯', triggers: ['create-bill'] },
  { slug: '500-bills',          category: 'volume',        icon: '🏃‍♂️', triggers: ['create-bill'] },
  { slug: '50-transactions',    category: 'volume',        icon: '📝', triggers: ['create-transaction'] },
  { slug: '200-transactions',   category: 'volume',        icon: '🧮', triggers: ['create-transaction'] },
  { slug: '500-transactions',   category: 'volume',        icon: '🔍', triggers: ['create-transaction'] },
  { slug: 'veteran',            category: 'volume',        icon: '🎖️', triggers: ['login', 'dashboard'] },
  { slug: 'rooted',             category: 'volume',        icon: '🌳', triggers: ['login', 'dashboard'] },
  { slug: 'legendary',          category: 'volume',        icon: '🏰', triggers: ['login', 'dashboard'] },
  { slug: 'eternal',            category: 'volume',        icon: '♾️', triggers: ['login', 'dashboard'] },

  // ─── Financial Advanced (10) ─────────────────────────────────────
  { slug: 'positive-balance',   category: 'financial',     icon: '📊', triggers: ['dashboard', 'pay-bill', 'create-transaction'] },
  { slug: 'surplus-3',          category: 'financial',     icon: '📈', triggers: ['dashboard'] },
  { slug: 'surplus-6',          category: 'financial',     icon: '🧠', triggers: ['dashboard'] },
  { slug: 'balance-guardian',   category: 'financial',     icon: '🛡️', triggers: ['dashboard'] },
  { slug: 'economist',          category: 'financial',     icon: '🎓', triggers: ['dashboard'] },
  { slug: 'frugal',             category: 'financial',     icon: '🧘', triggers: ['dashboard'] },
  { slug: 'debt-free',          category: 'financial',     icon: '🕊️', triggers: ['pay-bill'] },
  { slug: 'big-payment',        category: 'financial',     icon: '💸', triggers: ['pay-bill'] },
  { slug: 'epic-payment',       category: 'financial',     icon: '🏔️', triggers: ['pay-bill'] },
  { slug: 'investor',           category: 'financial',     icon: '🎰', triggers: ['create-goal'] },
]

export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map(a => [a.slug, a]))

export function getAchievementsByTrigger(trigger: string): AchievementDef[] {
  return ACHIEVEMENTS.filter(a => a.triggers.includes(trigger))
}
