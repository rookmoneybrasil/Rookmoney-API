import { withBackofficeAuth, getBackofficeAdmin } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, badRequest } from '@/lib/respond'
import bcrypt from 'bcryptjs'

// Manage backoffice admin accounts. Superadmin-only (enforced by the wrapper).
export default withBackofficeAuth(async (req, res) => {
  if (req.method === 'GET') {
    const admins = await db.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
    })
    return ok(res, { admins })
  }

  // POST — create a new admin
  const { email, password, name, role } = req.body as { email?: string; password?: string; name?: string; role?: string }
  if (!email || !password || !name) return badRequest(res, 'email, senha e nome são obrigatórios')
  if (password.length < 8) return badRequest(res, 'A senha deve ter ao menos 8 caracteres')
  if (role && role !== 'support' && role !== 'superadmin') return badRequest(res, 'role inválido')

  const normalizedEmail = email.toLowerCase().trim()
  const existing = await db.adminUser.findUnique({ where: { email: normalizedEmail } })
  if (existing) return badRequest(res, 'Já existe um admin com esse email')

  const passwordHash = await bcrypt.hash(password, 12)
  const created = await db.adminUser.create({
    data: { email: normalizedEmail, passwordHash, name: name.trim(), role: role ?? 'support' },
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
  })

  await db.adminLog.create({ data: {
    action: 'admin_account', targetId: created.id,
    details: `Admin criado: ${created.email} (${created.role})`,
    actorEmail: getBackofficeAdmin(req).email,
  }}).catch(() => {})

  return ok(res, created)
}, ['GET', 'POST'], { requireRole: 'superadmin' })
