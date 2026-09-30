import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from '../game/node_modules/ws/index.js'
import { verifyRoomsToken } from '../game/server/rooms-auth.ts'

const match = 'a'.repeat(64), key = 'test-only-server-key'
const uid = '01K00000000000000000000001'
const sign = (id = uid, exp = Math.floor(Date.now() / 1000) + 300, room = match) => {
  const body = `${room}.${id}.${exp}`
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}
test('Rooms tokens reject tampering, expiry, another match, malformed expiry and NaN', () => {
  assert.equal(verifyRoomsToken(sign(), key, match)?.uid, uid)
  for (const token of [sign() + 'x', sign(uid, 1), sign(uid, NaN), sign(uid, Infinity), sign(uid, Date.now(), 'b'.repeat(64)), 'bad']) {
    assert.equal(verifyRoomsToken(token, key, match), null)
  }
})
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await wait(100) }
  throw new Error('Timed out waiting for test state')
}
test('two guests join one match; wrong match rejected; lifecycle ready/join/leave/complete', { timeout: 30000 }, async (t) => {
  const callbacks = []
  const api = createServer(async (req, res) => {
    let data = ''
    for await (const part of req) data += part
    assert.equal(req.headers.authorization, `Bearer ${key}`)
    assert.equal(JSON.parse(data).matchId, match)
    callbacks.push(req.url)
    res.setHeader('content-type', 'application/json'); res.end('{}')
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  t.after(() => api.close())
  const portFinder = createServer()
  portFinder.listen(0, '127.0.0.1'); await once(portFinder, 'listening')
  const port = portFinder.address().port
  await new Promise((resolve) => portFinder.close(resolve))
  const child = spawn(process.execPath, ['game/dist-server/main.js'], { env: {
    ...process.env, PORT: String(port), MM_URL: `http://127.0.0.1:${api.address().port}`,
    MM_MATCH_ID: match, MM_SERVER_TOKEN: key, ALLOWED_ORIGINS: 'http://localhost', MAX_SESSION_SECONDS: '25',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d }); child.stderr.on('data', (d) => { output += d })
  t.after(() => child.kill('SIGKILL'))
  const health = await until(async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() } catch { return null }
  })
  await until(() => callbacks.includes('/ready'))
  async function guest(token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/match`, { origin: 'http://localhost' })
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    t.after(() => ws.terminate())
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'hello', v: health.protocol, build: health.build, token, guest: true, mode: 'ffa', map: 'scrapyard', loadout: { vehicle: 'razor', weapon: 'minigun' } }))
    const first = await until(() => messages.find((m) => ['welcome', 'err'].includes(m.t)))
    return { ws, messages, first }
  }
  const a = await guest(sign()), b = await guest(sign('01K00000000000000000000002'))
  assert.equal(a.first.room, match); assert.equal(b.first.room, match)
  assert.notEqual(a.first.seat, b.first.seat)
  assert.equal((await guest(sign(uid, undefined, 'b'.repeat(64)))).first.code, 'auth')
  await until(() => callbacks.includes(`/players/${uid}/joined`))
  await until(() => a.messages.some((m) => m.t === 's'))
  a.ws.close(); await until(() => callbacks.includes(`/players/${uid}/left`))
  assert.equal((await guest(sign())).first.code, 'auth', 'departed token cannot re-enter')
  const exited = once(child, 'exit'); child.kill('SIGTERM')
  await exited
  assert.ok(callbacks.includes('/complete'))
  assert.ok(!output.includes(key)); assert.ok(!output.includes(sign()))
})
