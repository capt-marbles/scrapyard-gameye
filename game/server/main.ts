import { initPhysics } from '../src/game/physics'
import { arenaData } from './arenas'
import { createGameServer } from './server'
import { verifyRoomsToken } from './rooms-auth'
import { RoomsLifecycle } from './rooms-lifecycle'

// Guest-only, one Rooms match per Gameye session. No Nakama dependency.
const env = process.env
const required = (name: string) => {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const number = (name: string, fallback: number) => {
  const value = Number(env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`)
  return value
}
const matchId = required('MM_MATCH_ID')
const token = required('MM_SERVER_TOKEN')
const lifecycle = new RoomsLifecycle(required('MM_URL').replace(/\/$/, ''), matchId, token)
const port = number('PORT', 7360)
const initialIdleSeconds = number('IDLE_SHUTDOWN_SECONDS', 120)
const emptyIdleSeconds = number('IDLE_SHUTDOWN_SECONDS', 30)
const maxSeconds = number('MAX_SESSION_SECONDS', 1200)
if (port > 65535) throw new Error('Invalid PORT')
const origins = required('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean)
if (!origins.length || origins.includes('*')) throw new Error('Explicit ALLOWED_ORIGINS required')
const departed = new Set<string>()
let stopping = false
let lastOccupied = Date.now()
let hadPlayers = false
await initPhysics()
arenaData('scrapyard')
const server = createGameServer({
  port, key: token, origins, maxRooms: 1, strict: true, trustProxy: env.TRUST_PROXY === '1',
  authenticate: (value) => {
    const identity = verifyRoomsToken(value, token, matchId)
    return identity && !departed.has(identity.uid) ? identity : null
  },
  managed: { id: matchId, mode: 'ffa', map: 'scrapyard', onComplete: () => queueMicrotask(() => void stop('match_complete')) },
  onJoin: (uid) => { hadPlayers = true; lastOccupied = Date.now(); lifecycle.player(uid, 'joined') },
  onLeave: (uid) => { departed.add(uid); lastOccupied = Date.now(); lifecycle.player(uid, 'left') },
})
let heartbeat: NodeJS.Timeout | undefined
let idle: NodeJS.Timeout | undefined
let deadline: NodeJS.Timeout | undefined
async function stop(reason: string) {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat); clearInterval(idle); clearTimeout(deadline)
  await server.close()
  try { await lifecycle.complete(reason) } catch { console.error(JSON.stringify({ msg: 'Rooms completion failed', reason })) }
  process.exit(0)
}
await server.listen()
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void stop(signal))
try { await lifecycle.send('/ready') } catch { await stop('ready_failed') }
let heartbeating = false
heartbeat = setInterval(() => {
  if (heartbeating || stopping) return
  heartbeating = true
  void lifecycle.send('/heartbeat').catch(() => stop('heartbeat_failed')).finally(() => { heartbeating = false })
}, 30_000)
idle = setInterval(() => {
  if (server.lobby.humans()) lastOccupied = Date.now()
  else if (Date.now() - lastOccupied > (hadPlayers ? emptyIdleSeconds : initialIdleSeconds) * 1000) void stop('empty')
}, 1000)
deadline = setTimeout(() => void stop('time_limit'), maxSeconds * 1000)
