import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'
import { ACHIEVEMENTS } from '@/lib/achievements'
import { checkAchievements } from '@/lib/achievement-checker'

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const unlocked = await db.userAchievement.findMany({
      where:  { userId: session.userId },
      select: { slug: true, unlockedAt: true, seen: true },
    })

    const unlockedMap = new Map(unlocked.map(u => [u.slug, u]))

    const achievements = ACHIEVEMENTS.map(a => {
      const u = unlockedMap.get(a.slug)
      return {
        slug:       a.slug,
        category:   a.category,
        icon:       a.icon,
        unlocked:   !!u,
        unlockedAt: u?.unlockedAt ?? null,
        seen:       u?.seen ?? false,
      }
    })

    const total    = ACHIEVEMENTS.length
    const done     = unlocked.length
    const unseen   = unlocked.filter(u => !u.seen).length

    return ok(res, { achievements, total, done, unseen })
  }

  // POST /achievements — trigger a manual check (e.g. on dashboard load)
  if (req.method === 'POST') {
    const trigger = (req.body?.trigger as string) ?? 'dashboard'
    const ctx     = (req.body?.ctx as Record<string, unknown>) ?? {}
    const newlyUnlocked = await checkAchievements(db, session.userId, trigger, ctx)
    return ok(res, { newlyUnlocked })
  }

  return res.status(405).end()
})
