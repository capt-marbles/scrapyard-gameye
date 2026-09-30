import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Miniflare, Response as WorkerResponse, convertV4MiniflareOptions } from 'miniflare'
import WebSocket from '../game/node_modules/ws/index.js'
const { WebSocketServer } = WebSocket

test('workerd proxies only a live Rooms member socket and preserves game messages', { timeout: 20000 }, async (t) => {
  const backend = createServer()
  const sockets = new WebSocketServer({ server: backend })
  sockets.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())))
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening')
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); backend.close() })
  const roomId = 'a'.repeat(64)
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'gateway-test', modules: true, scriptPath: 'edge/worker.js', compatibilityDate: '2026-09-26',
    serviceBindings: { ROOMS: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/v1/tickets') return WorkerResponse.json({ ticket: 'guest-ticket' })
      return WorkerResponse.json({ roomId, state: 'live', playerToken: 'signed', server: { host: '127.0.0.1', ports: { game: backend.address().port } } })
    } },
    bindings: { ROOMS_TENANT: 'scrapyard-dev', ROOMS_ORIGIN: 'https://rooms.example' },
  }] }))
  t.after(() => mf.dispose())
  const origin = (await mf.ready).origin
  const response = await fetch(`${origin}/rooms/v1/tickets`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'scrapyard-dev' }) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ticket, 'guest-ticket')
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/game/${roomId}?ticket=v2.scrapyard-dev.test`, { origin })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const received = once(ws, 'message')
  ws.send('game-state-probe')
  assert.equal(String((await received)[0]), 'game-state-probe')
  ws.close(); await once(ws, 'close')
})
