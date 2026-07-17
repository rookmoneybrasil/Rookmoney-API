import { createHmac, timingSafeEqual, randomBytes } from 'crypto'
import { getAccessToken } from './google-play'

// Play Integrity (Android-only) — attests the device/app before the server
// activates a paid plan from a Google Play purchase. Uses the SAME service
// account as Google Play verification (GOOGLE_PLAY_CREDENTIALS), just with the
// playintegrity OAuth scope. The Google Cloud project is already linked to the
// app in Play Console (project number 632276062518).

const PACKAGE_NAME = 'com.rookmoney.app'
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity'

// Nonce is a signed, short-lived token bound to a user. The app requests it,
// feeds it to the Play Integrity API, and Google echoes it back inside the
// decoded token (requestDetails.nonce). We re-verify it belongs to the user and
// isn't stale — anti-replay. Kept stateless (HMAC over JWT_SECRET) so there's no
// extra DB table, mirroring how the rest of the auth layer signs things.
const NONCE_TTL_MS = 10 * 60 * 1000 // 10 minutes — nonce→token→verify takes seconds

function sign(data: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not configured')
  return createHmac('sha256', secret).update(data).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// The WHOLE nonce is URL-safe base64 (base64url → only [A-Za-z0-9_-], no '.', '+',
// '/' or '=' padding) because the Play Integrity classic request requires it —
// a nonce with any other char is rejected by requestIntegrityToken, which would
// make the app send no token and the server silently skip the gate. We base64url
// a JSON envelope { body, sig } where body is itself a JSON { u, t, r }.
export function issueNonce(userId: string): string {
  const body = JSON.stringify({ u: userId, t: Date.now(), r: randomBytes(9).toString('base64url') })
  const envelope = JSON.stringify({ body, sig: sign(body) })
  return Buffer.from(envelope, 'utf8').toString('base64url')
}

export function verifyNonce(nonce: string | null | undefined, userId: string): boolean {
  if (!nonce || typeof nonce !== 'string') return false

  let envelope: { body?: string; sig?: string }
  try {
    envelope = JSON.parse(Buffer.from(nonce, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  if (!envelope?.body || !envelope?.sig) return false
  if (!safeEqual(sign(envelope.body), envelope.sig)) return false

  let inner: { u?: string; t?: number }
  try {
    inner = JSON.parse(envelope.body)
  } catch {
    return false
  }
  if (inner.u !== userId) return false
  if (typeof inner.t !== 'number' || !Number.isFinite(inner.t)) return false
  return Date.now() - inner.t <= NONCE_TTL_MS
}

export interface IntegrityVerdict {
  appRecognition: string | null // PLAY_RECOGNIZED | UNRECOGNIZED_VERSION | UNEVALUATED
  deviceIntegrity: string[] // e.g. ['MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY']
  appLicensing: string | null // LICENSED | UNLICENSED | UNEVALUATED
  nonce: string | null
  raw: unknown
}

export async function decodeIntegrityToken(integrityToken: string): Promise<IntegrityVerdict> {
  const accessToken = await getAccessToken(PLAY_INTEGRITY_SCOPE)
  const url = `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ integrityToken }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Play Integrity decode failed: ${text}`)
  }

  const data = await res.json()
  const p = data?.tokenPayloadExternal ?? {}
  const deviceVerdict = p.deviceIntegrity?.deviceRecognitionVerdict
  return {
    appRecognition: p.appIntegrity?.appRecognitionVerdict ?? null,
    // Defensive: a failing device returns an empty array or omits the field; guard
    // against any non-array shape so evaluateVerdict's .includes/.join can't throw.
    deviceIntegrity: Array.isArray(deviceVerdict) ? deviceVerdict : [],
    appLicensing: p.accountDetails?.appLicensingVerdict ?? null,
    nonce: p.requestDetails?.nonce ?? p.requestDetails?.requestHash ?? null,
    raw: p,
  }
}

export interface IntegrityEvaluation {
  ok: boolean
  reasons: string[]
  summary: string
}

// Blocking policy is intentionally narrow to minimize false-positives on real
// paying customers: only the strong fraud signals fail the check.
//   - device has no MEETS_DEVICE_INTEGRITY  → emulator / rooted / uncertified
//   - app is UNRECOGNIZED_VERSION           → repackaged / modified APK
// UNEVALUATED (can't determine — happens on internal test tracks) and licensing
// verdicts are logged but never block. The nonce check is handled by the caller
// as a separate (log-only) signal, so a clock/TTL edge never blocks a purchase.
export function evaluateVerdict(v: IntegrityVerdict): IntegrityEvaluation {
  const reasons: string[] = []

  if (!v.deviceIntegrity.includes('MEETS_DEVICE_INTEGRITY')) {
    reasons.push(`device=[${v.deviceIntegrity.join(',') || 'none'}]`)
  }
  if (v.appRecognition === 'UNRECOGNIZED_VERSION') {
    reasons.push('app=UNRECOGNIZED_VERSION')
  }

  const summary = `device=[${v.deviceIntegrity.join(',')}] app=${v.appRecognition ?? '-'} lic=${v.appLicensing ?? '-'}`
  return { ok: reasons.length === 0, reasons, summary }
}

// Shared 403 payload so the pre-purchase check and the verify endpoint deny with
// the exact same message + code (single source — never re-type this string).
export const INTEGRITY_DENIED = {
  error:
    'Não foi possível validar a integridade do dispositivo. Compras não são permitidas em aparelhos com root, emuladores ou versões modificadas do app.',
  code: 'INTEGRITY_FAILED' as const,
}

export interface IntegrityGateResult {
  allow: boolean
  // Line to persist to AdminLog; null when there's nothing to record (no token in
  // tolerant mode). The caller owns the DB write (this stays pure/testable).
  log: string | null
}

// The single decision point for the whole Play Integrity gate. Both the
// pre-purchase check (POST /billing/integrity-check) and the purchase verify
// (POST /billing/google-play) call this — so the enforce/require policy can never
// drift between the two surfaces.
//   - PLAY_INTEGRITY_ENFORCE (default ON): deny when a present token FAILS the verdict.
//   - PLAY_INTEGRITY_REQUIRE (default OFF): also deny when no token / undecodable.
export async function runIntegrityGate(
  integrityToken: string | null | undefined,
  userId: string,
): Promise<IntegrityGateResult> {
  const enforce = process.env.PLAY_INTEGRITY_ENFORCE !== 'false'
  const requireIntegrity = process.env.PLAY_INTEGRITY_REQUIRE === 'true'

  if (!integrityToken) {
    if (requireIntegrity) return { allow: false, log: 'BLOCK — missing integrity token (require mode)' }
    return { allow: true, log: null }
  }

  try {
    const verdict = await decodeIntegrityToken(integrityToken)
    const evalResult = evaluateVerdict(verdict)
    // Nonce is a secondary, log-only signal — never denies on its own (a clock/TTL
    // edge must not stop a genuine device from paying). The verdict is the real gate.
    const nonceOk = verifyNonce(verdict.nonce, userId)
    const log = `${evalResult.ok ? 'PASS' : 'FAIL'} — ${evalResult.summary} nonce=${nonceOk ? 'ok' : 'bad'}${evalResult.reasons.length ? ` [${evalResult.reasons.join(', ')}]` : ''}`
    return { allow: !(enforce && !evalResult.ok), log }
  } catch (err) {
    // Decode failure = infra/outage, not fraud → fail-open by default (allow). In
    // strict mode an undecodable token is treated as a failed attestation.
    console.error('[integrity] decode error:', err instanceof Error ? err.message : err)
    const log = `ERROR — ${err instanceof Error ? err.message : 'decode failed'}`
    return { allow: !requireIntegrity, log }
  }
}
