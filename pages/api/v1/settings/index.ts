import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import bcrypt from 'bcryptjs'

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
      },
    })
    if (!user) return res.status(404).end()
    const { googleId, ...rest } = user
    return ok(res, { ...rest, hasGoogle: googleId !== null })
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
      await db.user.update({ where: { id: session.userId }, data: { password: hashed } })
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
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    await db.user.delete({ where: { id: session.userId } })
    return ok(res, { message: 'Conta excluída.' })
  }

  return res.status(405).end()
})
