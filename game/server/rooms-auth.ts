import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Identity } from './auth'

// Rooms match.ready.playerToken, NOT the matchmaking ticket or a Nakama JWT.
export function verifyRoomsToken(token: string, serverToken: string, matchId: string, now = Date.now() / 1000): Identity | null {
  if (typeof token !== 'string' || token.length > 1024 || !serverToken || !matchId) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [match, uid, expiry, signature] = parts
  if (match !== matchId || !/^[0-9A-Z]{26}$/.test(uid) || !/^\d+$/.test(expiry)) return null
  const exp = Number(expiry)
  if (!Number.isSafeInteger(exp) || exp <= now || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null
  const expected = createHmac('sha256', serverToken).update(`${match}.${uid}.${expiry}`).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  return { uid, username: `Guest ${uid.slice(-4)}`, expires: exp }
}
