// Allocates ONE real development match for two guests. Logs no tickets/tokens.
import assert from 'node:assert/strict'
import WebSocket from '../game/node_modules/ws/index.js'
import { buildId } from '../game/build-id.ts'
const base = process.env.SCRAPYARD_URL || 'https://scrapyard-gameye-dev.andrew-48d.workers.dev'
const sockets = []
const guests = []
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}/rooms${path}`, { method, signal: AbortSignal.timeout(20000),
    headers: { origin: base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`Rooms request returned ${response.status}`)
  return response.json()
}
async function join(room, guest) {
  const url = `${base.replace('https:', 'wss:')}/game/${room.roomId}?ticket=${encodeURIComponent(guest.ticket)}`
  const ws = new WebSocket(url, { origin: base })
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Game join timed out')), 15000)
    ws.on('error', () => { clearTimeout(timer); reject(new Error('Game socket failed')) })
    ws.on('unexpected-response', (_req, response) => { clearTimeout(timer); reject(new Error(`Gateway returned ${response.statusCode}; upstream ${response.headers['x-game-upstream-status'] || 'unknown'}`)) })
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 3, build: buildId(), token: room.playerToken,
      guest: true, mode: 'ffa', map: 'scrapyard', loadout: { vehicle: 'razor', weapon: 'minigun' },
    })))
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.t === 'err') { clearTimeout(timer); reject(new Error(`Game refused: ${message.code}`)) }
      if (message.t === 'welcome') { clearTimeout(timer); resolve(message) }
    })
  })
}
try {
  for (let i = 0; i < 2; i++) {
    const ticket = await api('/v1/tickets', 'POST', { tenantId: 'scrapyard-dev' })
    const admission = await api('/v1/queue', 'POST', { ticket: ticket.ticket, playlist: 'ffa-scrapyard' })
    guests.push({ ...ticket, ...admission })
  }
  assert.equal(guests[0].roomId, guests[1].roomId)
  console.log('Two guests assigned to the same room')
  let snapshots
  for (let i = 0; i < 75; i++) {
    snapshots = await Promise.all(guests.map((g) => api(`/v1/rooms/${g.roomId}?ticket=${encodeURIComponent(g.ticket)}`)))
    if (snapshots.some((s) => s.state === 'closed')) throw new Error(`Room closed: ${snapshots[0].closedReason}`)
    if (snapshots.every((s) => s.state === 'live')) break
    if (i % 5 === 0) console.log(`Waiting: ${snapshots[0].state}`)
    await wait(2000)
  }
  assert.ok(snapshots.every((s) => s.state === 'live'))
  console.log('Gameye allocation and managed readiness confirmed')
  const welcomes = await Promise.all(guests.map((g, i) => join(snapshots[i], g)))
  assert.equal(welcomes[0].room, welcomes[1].room)
  assert.notEqual(welcomes[0].seat, welcomes[1].seat)
  const snapshotsReceived = [0, 0]
  sockets.forEach((ws, i) => ws.on('message', (data) => { if (JSON.parse(String(data)).t === 's') snapshotsReceived[i]++ }))
  await wait(5000)
  assert.ok(snapshotsReceived.every((count) => count > 30))
  console.log(JSON.stringify({ result: 'LIVE SMOKE PASS', distinctSeats: true, snapshotsReceived }))
} finally {
  for (const ws of sockets) { if (ws.readyState === ws.OPEN) ws.close(); else ws.terminate() }
  for (const guest of guests) if (guest.roomId) await api(`/v1/rooms/${guest.roomId}/leave`, 'POST', { ticket: guest.ticket }).catch(() => undefined)
}
