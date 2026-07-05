import { withBackofficeAuth, getBackofficeAdmin } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, noContent, notFound, badRequest } from '@/lib/respond'
import bcrypt from 'bcryptjs'

// Edit / deactivate / delete a backoffice admin. Superadmin-only.
export default withBackofficeAuth(async (req, res) => {
  const id = req.query.id as string
  const target = await db.adminUser.findUnique({ where: { id } })
  if (!target) return notFound(res)

  const actor = getBackofficeAdmin(req)

  if (req.method === 'PATCH') {
    const { role, active, password } = req.body as { role?: string; active?: boolean; password?: string }
    const data: Record<string, unknown> = {}

    if (role !== undefined) {
      if (role !== 'support' && role !== 'superadmin') return badRequest(res, 'role inválido')
      data.role = role
    }
    if (active !== undefined) {
      // Don't let an admin lock themselves out or drop the last active superadmin
      if (!active && target.role === 'superadmin') {
        const activeSupers = await db.adminUser.count({ where: { role: 'superadmin', active: true } })
        if (activeSupers <= 1) return badRequest(res, 'Não é possível desativar o último superadmin ativo')
      }
      data.active = active
    }
    if (password !== undefined) {
      if (password.length < 8) return badRequest(res, 'A senha deve ter ao menos 8 caracteres')
      data.passwordHash = await bcrypt.hash(password, 12)
    }

    const updated = await db.adminUser.update({
      where: { id }, data,
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
    })
    await db.adminLog.create({ data: {
      action: 'admin_account', targetId: id,
      details: `Admin atualizado: ${target.email}${role ? ` role→${role}` : ''}${active !== undefined ? ` ${active ? 'ativado' : 'desativado'}` : ''}${password ? ' senha alterada' : ''}`,
      actorEmail: actor.email,
    }}).catch(() => {})
    return ok(res, updated)
  }

  if (req.method === 'DELETE') {
    if (target.role === 'superadmin') {
      const activeSupers = await db.adminUser.count({ where: { role: 'superadmin', active: true } })
      if (activeSupers <= 1) return badRequest(res, 'Não é possível excluir o último superadmin ativo')
    }
    await db.adminUser.delete({ where: { id } })
    await db.adminLog.create({ data: {
      action: 'admin_account', targetId: id,
      details: `Admin excluído: ${target.email}`,
      actorEmail: actor.email,
    }}).catch(() => {})
    return noContent(res)
  }

  return res.status(405).end()
}, ['PATCH', 'DELETE'], { requireRole: 'superadmin' })
