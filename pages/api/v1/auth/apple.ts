import type { NextApiRequest, NextApiResponse } from 'next'
import { db } from '@/lib/db'
import { createToken } from '@/lib/auth'
import { verifyAppleToken } from '@/lib/apple-auth'
import { ok, badRequest, serverError } from '@/lib/respond'
import { checkAchievements } from '@/lib/achievement-checker'
import { sendWelcomeEmail } from '@/lib/email'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { identityToken, name } = req.body as {
    identityToken: string
    name?: string  // only sent on first sign-in
  }

  if (!identityToken) return badRequest(res, 'identityToken é obrigatório')

  try {
    const { sub: appleId, email } = await verifyAppleToken(identityToken)

    // Find existing user by appleId
    let user = await db.user.findUnique({
      where:  { appleId },
      select: { id: true, name: true, email: true, plan: true, tokenVersion: true },
    })

    if (!user) {
      // Try to link to existing account by email (Apple may provide relay email)
      if (email) {
        const byEmail = await db.user.findUnique({
          where:  { email: email.toLowerCase() },
          select: { id: true, name: true, email: true, plan: true, tokenVersion: true },
        })
        if (byEmail) {
          user = await db.user.update({
            where:  { id: byEmail.id },
            data:   { appleId },
            select: { id: true, name: true, email: true, plan: true, tokenVersion: true },
          })
        }
      }
    }

    if (!user) {
      // New user — create account
      const finalEmail = email?.toLowerCase() ?? `apple_${appleId}@privaterelay.appleid.com`
      const finalName  = name?.trim() || 'Usuário Apple'

      user = await db.user.create({
        data: {
          appleId,
          email:   finalEmail,
          name:    finalName,
          plan:    'FREE',
        },
        select: { id: true, name: true, email: true, plan: true, tokenVersion: true },
      })

      checkAchievements(db, user.id, 'register').catch(() => {})
      sendWelcomeEmail(finalEmail, finalName).catch(() => {})
    }

    const token = await createToken({
      userId:       user.id,
      name:         user.name,
      email:        user.email,
      tokenVersion: user.tokenVersion,
    }, true)

    return ok(res, { token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } })
  } catch (err) {
    console.error('[apple-auth]', err)
    return serverError(res, err)
  }
}
