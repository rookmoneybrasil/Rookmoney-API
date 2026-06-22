import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import bcrypt from 'bcryptjs'
import { checkAchievements } from '@/lib/achievement-checker'

// Fix 2: profileImage SSRF protection — only allow trusted image hosts over HTTPS
const ALLOWED_IMAGE_HOSTS = [
  'lh3.googleusercontent.com', 'googleusercontent.com',
  'gravatar.com', 'secure.gravatar.com',
  'i.imgur.com', 'avatars.githubusercontent.com',
  'unavatar.io', 'avatar.vercel.sh',
  'images.unsplash.com', 'cdn.discordapp.com',
]
function validateImageUrl(url: string | null): boolean {
  if (!url) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_IMAGE_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))
  } catch { return false }
}

// Fix 3: max lengths for user-controlled text fields
const FIELD_LIMITS = { name: 100, bio: 160, city: 80, occupation: 80 }

export default withAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    const user = await db.user.findUnique({
      where:  { id: session.userId },
      select: {
        id: true, name: true, email: true, plan: true,
        hasOnboarded: true, whatsappPhone: true, createdAt: true,
        profileImage: true, bio: true, city: true, occupation: true, birthdate: true,
        googleId: true,
        notifBillReminder: true, notifCategoryLimit: true, notifMonthlyEmail: true,
        currency: true, dateFormat: true,
        stripeCustomerId: true, stripeSubscriptionId: true,
        stripeCancelAtPeriodEnd: true, stripeCurrentPeriodEnd: true, updatedAt: true,
      },
    })
    if (!user) return res.status(404).end()

    let syncedCancel = user.stripeCancelAtPeriodEnd
    let syncedPeriodEnd: Date | null = user.stripeCurrentPeriodEnd

    const staleMs = 5 * 60 * 1000
    const isStale = !user.stripeCurrentPeriodEnd || (Date.now() - user.updatedAt.getTime()) > staleMs
    if (user.stripeSubscriptionId && isStale) {
      try {
        const { getSubscription } = await import('@/lib/stripe')
        const sub = await getSubscription(user.stripeSubscriptionId)
        if (sub) {
          const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end
          syncedCancel = sub.cancel_at_period_end || sub.cancel_at !== null
          syncedPeriodEnd = sub.cancel_at ? new Date(sub.cancel_at * 1000) : periodEnd ? new Date(periodEnd * 1000) : null
          await db.user.update({
            where: { id: session.userId },
            data: { stripeCancelAtPeriodEnd: syncedCancel, stripeCurrentPeriodEnd: syncedPeriodEnd },
          }).catch(() => {})
        }
      } catch (err) { console.error('[settings] Stripe sync failed:', err instanceof Error ? err.message : err) }
    }

    const { googleId, updatedAt: _u, ...rest } = user
    return ok(res, { ...rest, stripeCancelAtPeriodEnd: syncedCancel, stripeCurrentPeriodEnd: syncedPeriodEnd, hasGoogle: googleId !== null })
  }

  if (req.method === 'PATCH') {
    const { action } = req.query

    if (action === 'password') {
      const { currentPassword, newPassword } = req.body
      if (!currentPassword || !newPassword) return badRequest(res, 'Senha atual e nova senha são obrigatórias.')
      if (newPassword.length < 8) return badRequest(res, 'Nova senha deve ter no mínimo 8 caracteres.')
      const user = await db.user.findUnique({ where: { id: session.userId }, select: { password: true } })
      if (!user?.password) return badRequest(res, 'Esta conta usa login pelo Google.')
      const valid = await bcrypt.compare(currentPassword, user.password)
      if (!valid) return badRequest(res, 'Senha atual incorreta.')
      const hashed = await bcrypt.hash(newPassword, 12)
      // Fix 5: increment tokenVersion to invalidate all existing sessions
      await db.user.update({ where: { id: session.userId }, data: { password: hashed, tokenVersion: { increment: 1 } } })
      return ok(res, { message: 'Senha alterada com sucesso.' })
    }

    if (action === 'disconnect-google') {
      const user = await db.user.findUnique({ where: { id: session.userId }, select: { password: true, googleId: true } })
      if (!user?.googleId) return badRequest(res, 'Google não está conectado.')
      if (!user.password)  return badRequest(res, 'Configure uma senha antes de desconectar o Google.')
      await db.user.update({ where: { id: session.userId }, data: { googleId: null } })
      return ok(res, { message: 'Google desconectado.' })
    }

    if (action === 'notifications') {
      const { notifBillReminder, notifCategoryLimit, notifMonthlyEmail } = req.body
      await db.user.update({
        where: { id: session.userId },
        data: {
          ...(notifBillReminder  !== undefined && { notifBillReminder:  Boolean(notifBillReminder)  }),
          ...(notifCategoryLimit !== undefined && { notifCategoryLimit: Boolean(notifCategoryLimit) }),
          ...(notifMonthlyEmail  !== undefined && { notifMonthlyEmail:  Boolean(notifMonthlyEmail)  }),
        },
      })
      return ok(res, { message: 'Notificações salvas.' })
    }

    if (action === 'preferences') {
      const { currency, dateFormat } = req.body
      const validCurrencies  = ['BRL', 'USD', 'EUR']
      const validDateFormats = ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']
      if (currency   && !validCurrencies.includes(currency))   return badRequest(res, 'Moeda inválida.')
      if (dateFormat && !validDateFormats.includes(dateFormat)) return badRequest(res, 'Formato de data inválido.')
      await db.user.update({
        where: { id: session.userId },
        data: {
          ...(currency   !== undefined && { currency }),
          ...(dateFormat !== undefined && { dateFormat }),
        },
      })
      return ok(res, { message: 'Preferências salvas.' })
    }

    // Default: update profile fields
    const { name, whatsappPhone, profileImage, bio, city, occupation, birthdate } = req.body

    // Fix 2: validate profileImage URL
    if (profileImage && !validateImageUrl(profileImage)) {
      return badRequest(res, 'URL de imagem inválida. Use uma URL HTTPS de um serviço permitido (Google, Gravatar, etc.).')
    }
    // Fix 3: validate field lengths
    if (name       && name.length       > FIELD_LIMITS.name)       return badRequest(res, `Nome muito longo (máx ${FIELD_LIMITS.name} chars).`)
    if (bio        && bio.length        > FIELD_LIMITS.bio)        return badRequest(res, `Bio muito longa (máx ${FIELD_LIMITS.bio} chars).`)
    if (city       && city.length       > FIELD_LIMITS.city)       return badRequest(res, `Cidade muito longa (máx ${FIELD_LIMITS.city} chars).`)
    if (occupation && occupation.length > FIELD_LIMITS.occupation) return badRequest(res, `Profissão muito longa (máx ${FIELD_LIMITS.occupation} chars).`)

    const updated = await db.user.update({
      where: { id: session.userId },
      data: {
        ...(name          !== undefined && { name }),
        ...(whatsappPhone !== undefined && { whatsappPhone: whatsappPhone || null }),
        ...(profileImage  !== undefined && { profileImage:  profileImage  || null }),
        ...(bio           !== undefined && { bio:           bio           || null }),
        ...(city          !== undefined && { city:          city          || null }),
        ...(occupation    !== undefined && { occupation:    occupation    || null }),
        ...(birthdate     !== undefined && { birthdate: birthdate ? new Date(birthdate) : null }),
      },
      select: {
        id: true, name: true, email: true, plan: true,
        hasOnboarded: true, whatsappPhone: true,
        profileImage: true, bio: true, city: true, occupation: true, birthdate: true,
      },
    })
    checkAchievements(db, session.userId, 'update-profile').catch(() => {})
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.user.delete({ where: { id: session.userId } })
    return ok(res, { message: 'Conta excluída.' })
  }

  return res.status(405).end()
})
