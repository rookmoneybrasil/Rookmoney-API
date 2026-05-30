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
      },
    })
    return ok(res, user)
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

    // Update profile (name, whatsapp + new fields)
    const { name, whatsappPhone, profileImage, bio, city, occupation, birthdate } = req.body
    const updated = await db.user.update({
      where: { id: session.userId },
      data: {
        ...(name         !== undefined && { name }),
        ...(whatsappPhone !== undefined && { whatsappPhone: whatsappPhone || null }),
        ...(profileImage !== undefined && { profileImage: profileImage || null }),
        ...(bio          !== undefined && { bio: bio || null }),
        ...(city         !== undefined && { city: city || null }),
        ...(occupation   !== undefined && { occupation: occupation || null }),
        ...(birthdate    !== undefined && { birthdate: birthdate ? new Date(birthdate) : null }),
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
