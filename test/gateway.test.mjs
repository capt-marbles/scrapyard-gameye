import assert from 'node:assert/strict'
import { test } from 'node:test'
import gateway, { gameTarget, readJsonBounded } from '../edge/worker.js'
const roomId = 'a'.repeat(64)
const env = { ROOMS_TENANT: 'scrapyard-dev', ROOMS_ORIGIN: 'https://rooms.example', ROOMS: {
  fetch: async () => Response.json({ roomId, state: 'live', playerToken: 'signed-token', server: { host: 'game.example', ports: { game: 32123 } } }),
} }
test('game target comes only from authorized live room', async () => {
  assert.equal(await gameTarget(env, roomId, 'v2.scrapyard-dev.ticket'), 'http://game.example:32123/match')
  assert.equal(await gameTarget(env, roomId, 'v2.other.ticket'), null)
  assert.equal(await gameTarget(env, '../admin', 'v2.scrapyard-dev.ticket'), null)
  assert.equal(await gameTarget({ ...env, ROOMS: { fetch: async () => new Response('', { status: 403 }) } }, roomId, 'v2.scrapyard-dev.ticket'), null)
  assert.equal(await gameTarget({ ...env, ROOMS: { fetch: async () => Response.json({ roomId, state: 'starting' }) } }, roomId, 'v2.scrapyard-dev.ticket'), null)
})
test('proxy does not expose operator or lifecycle endpoints', async () => {
  for (const path of ['/rooms/v1/tenant', '/rooms/mcp', '/rooms/v1/server/scrapyard-dev/ready']) {
    assert.equal((await gateway.fetch(new Request(`https://game.example${path}`, { method: 'POST' }), env)).status, 404)
  }
})
test('JSON decoding is bounded', async () => {
  await assert.rejects(readJsonBounded(new Response('a'.repeat(100)), 10))
})
