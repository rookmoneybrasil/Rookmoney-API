import { withBackofficeAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok } from '@/lib/respond'

export default withBackofficeAuth(async (req, res) => {
  const { page = '1', pageSize = '40', status = '', phone = '' } = req.query as Record<string, string>
  const skip = (parseInt(page) - 1) * parseInt(pageSize)

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (phone) where.phone = { contains: phone }

  const now = new Date()
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  const [items, total, todayCount, outbound7d, failed7d, activeUsers7d] = await Promise.all([
    db.whatsAppLog.findMany({
      where, orderBy: { createdAt: 'desc' },
      skip, take: parseInt(pageSize),
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.whatsAppLog.count({ where }),
    db.whatsAppLog.count({ where: { createdAt: { gte: todayStart } } }),
    db.whatsAppLog.count({ where: { direction: 'outbound', createdAt: { gte: sevenDaysAgo } } }),
    db.whatsAppLog.count({ where: { direction: 'outbound', status: 'failed', createdAt: { gte: sevenDaysAgo } } }),
    db.whatsAppLog.findMany({
      where: { userId: { not: null }, createdAt: { gte: sevenDaysAgo } },
      distinct: ['userId'],
      select: { userId: true },
    }),
  ])

  return ok(res, {
    summary: {
      today: todayCount,
      failureRate7d: outbound7d > 0 ? Math.round((failed7d / outbound7d) * 1000) / 10 : 0,
      activeUsers7d: activeUsers7d.length,
    },
    items: items.map(l => ({
      id: l.id,
      phone: l.phone,
      direction: l.direction,
      status: l.status,
      messageType: l.messageType,
      error: l.error,
      createdAt: l.createdAt,
      user: l.user,
    })),
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(pageSize)),
  })
}, ['GET'])
