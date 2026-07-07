import { decodeProtectedHeader, jwtVerify, importX509 } from 'jose'
import { X509Certificate } from 'crypto'

// Apple Root CA - G3 (EC, 2014-2039, never changes)
// Source: https://www.apple.com/certificateauthority/
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygnnTY5b8+GSlt0a0Ro47+N9U1Tz5kAm0
KI0PLhDSfiqkMlgNPQeBf8Z3bgHw3YHEdMvnHhO3VkJNlL/RspZzH5TmMBDyoVAl
oZQxBqGYHfMJjKaNRTBRMB0GA1UdDgQWBBS7sN6hWDOImqSKmd6+veuv2sskqDAP
BgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFLuw3qFYM4iapIqZ3r6967Pa+ySq
MAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3m
eoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2Qi
olmll/nH7P+FFwn8myjbgqMQbuu8jQ==
-----END CERTIFICATE-----`

export interface AppleTransactionInfo {
  productId: string
  originalTransactionId: string
  transactionId: string
  purchaseDate: number    // ms timestamp
  expiresDate?: number    // ms timestamp
  bundleId: string
  type: string
}

// Parse one x5c entry (base64 DER) into an X509Certificate. Prefer the PEM
// reader (OpenSSL's PEM_read_bio_X509 reads exactly one cert and tolerates
// trailing bytes) over feeding a raw DER Buffer (d2i_X509 throws
// ERR_OSSL_ASN1_TOO_LONG on Apple's StoreKit 2 certs). Falls back to DER and,
// if both fail, throws with byte-level diagnostics.
function parseX5cCertificate(b64: string, idx: number): X509Certificate {
  const pemBody = b64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')
  const pem = `-----BEGIN CERTIFICATE-----\n${pemBody}\n-----END CERTIFICATE-----\n`
  try {
    return new X509Certificate(pem)
  } catch (pemErr) {
    try {
      return new X509Certificate(Buffer.from(b64, 'base64'))
    } catch (derErr) {
      const buf = Buffer.from(b64, 'base64')
      const declared = buf.length >= 4 && buf[0] === 0x30 && buf[1] === 0x82
        ? buf[2] * 256 + buf[3] + 4
        : '?'
      throw new Error(
        `cert[${idx}] parse failed (b64Len=${b64.length}, derBytes=${buf.length}, declaredTotal=${declared}) ` +
        `PEM=${pemErr instanceof Error ? pemErr.message : pemErr} | DER=${derErr instanceof Error ? derErr.message : derErr}`,
      )
    }
  }
}

export async function verifyAppleSignedTransaction(jwsTransaction: string): Promise<AppleTransactionInfo> {
  // TEMP DIAGNOSTIC: reveal the shape of the token that fails to verify.
  // Safe to log (no full token / no secrets) — remove after the fix is confirmed.
  const dots = (jwsTransaction.match(/\./g) || []).length
  console.log(`[apple-iap] token shape: len=${jwsTransaction.length} dots=${dots} head="${jwsTransaction.slice(0, 40)}"`)

  const header = decodeProtectedHeader(jwsTransaction) as { x5c?: string[]; alg?: string }
  console.log(`[apple-iap] header: alg=${header.alg} x5cCount=${header.x5c?.length ?? 0} cert0Len=${header.x5c?.[0]?.length ?? 0}`)

  if (!header.x5c || header.x5c.length < 2) {
    throw new Error('Missing x5c certificate chain in JWS header')
  }

  // Build X509Certificate from each x5c entry. The x5c values are base64 DER,
  // but feeding a raw DER Buffer to Node's X509Certificate throws
  // ERR_OSSL_ASN1_TOO_LONG on Apple's StoreKit 2 certs (d2i is strict about
  // trailing bytes). Wrapping in PEM armor uses OpenSSL's lenient PEM reader,
  // which parses exactly one certificate. Fall back to DER, and if both fail
  // surface byte-level diagnostics.
  const certs = header.x5c.map((c, idx) => parseX5cCertificate(c, idx))

  // Verify each cert is signed by the next in chain (leaf → intermediate → root)
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`Certificate chain broken at index ${i}`)
    }
  }

  // Verify the final cert is signed by Apple Root CA G3
  const rootCert = new X509Certificate(APPLE_ROOT_CA_G3)
  const topCert = certs[certs.length - 1]
  if (!topCert.verify(rootCert.publicKey)) {
    throw new Error('Certificate chain not rooted in Apple Root CA G3')
  }

  // Verify JWT signature using leaf certificate's public key
  const publicKey = await importX509(certs[0].toString(), 'ES256')
  const { payload } = await jwtVerify(jwsTransaction, publicKey)

  return {
    productId:             payload['productId'] as string,
    originalTransactionId: payload['originalTransactionId'] as string,
    transactionId:         payload['transactionId'] as string,
    purchaseDate:          payload['purchaseDate'] as number,
    expiresDate:           payload['expiresDate'] as number | undefined,
    bundleId:              payload['bundleId'] as string,
    type:                  payload['type'] as string,
  }
}

export function planFromAppleProductId(productId: string): 'PRO' | 'PRO_PLUS' {
  if (productId.includes('pro_plus') || productId.includes('plus')) return 'PRO_PLUS'
  return 'PRO'
}
