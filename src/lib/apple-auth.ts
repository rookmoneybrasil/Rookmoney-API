import { createRemoteJWKSet, jwtVerify } from 'jose'

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'))

export interface AppleTokenPayload {
  sub:   string          // Apple user ID
  email: string | null
}

export async function verifyAppleToken(identityToken: string): Promise<AppleTokenPayload> {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer:   'https://appleid.apple.com',
    audience: 'com.rookmoney.app',
  })

  const sub   = payload.sub as string
  const email = (payload.email as string | undefined) ?? null

  if (!sub) throw new Error('Token Apple inválido: sub ausente')

  return { sub, email }
}
