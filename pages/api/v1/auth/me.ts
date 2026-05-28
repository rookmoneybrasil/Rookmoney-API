import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '@/lib/middleware'
import { db } from '@/lib/db'
import { ok, notFound } from '@/lib/respond'

export default withAuth(async (req, res, session) => {
  if (req.method !== 'GET') return res.status(405).end()

  const [user, unpaidBills, openPeople] = await Promise.all([
    db.user.findUnique({
      where:  { id: session.userId },
      select: { id: true, name: true, email: true, plan: true, hasOnboarded: true, whatsappPhone: true, createdAt: true },
    }),
    db.bill.count({ where: { userId: session.userId, isPaid: false } }),
    db.person.count({ where: { userId: session.userId, entries: { some: { isSettled: false } } } }),
  ])

  if (!user) return notFound(res)
  return ok(res, {
    ...user,
    badges: { '/bills': unpaidBills, '/people': openPeople },
  })
})
