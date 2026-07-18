import { db } from '@/lib/db'

// The category a Transaction is filed under when its source record (a bill, a
// person entry, a goal contribution, a recurring) carries no category of its
// own. Prefers the neutral "Outros" default over "the first default" — the old
// `orderBy: { isDefault: 'desc' }` fallback resolved to "Moradia" (seeded first),
// so every uncategorized payment silently piled into Moradia. This is the single
// source of truth for that decision: callers must consume it, never re-derive it
// (see CLAUDE.md — duplicated balance/category logic is the #1 silent-bug class).
// Returns null only if the user somehow has no categories at all; callers already
// handle that (they error out cleanly before mutating anything).
export async function resolveFallbackCategoryId(userId: string): Promise<string | null> {
  const outros = await db.category.findFirst({
    where: { name: { equals: 'Outros', mode: 'insensitive' }, OR: [{ isDefault: true }, { userId }] },
  })
  if (outros) return outros.id

  const first = await db.category.findFirst({
    where: { OR: [{ isDefault: true }, { userId }] },
    orderBy: { isDefault: 'desc' },
  })
  return first?.id ?? null
}
