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
test('uses operator-configured DNS for allocated IPv4 origins', async () => {
  const ipEnv = { ...env, GAMEYE_IPV4_DNS_SUFFIX: 'sslip.io', ROOMS: { fetch: async () => Response.json({ roomId, state: 'live', playerToken: 'signed', server: { host: '51.195.60.60', ports: { game: 32123 } } }) } }
  assert.equal(await gameTarget(ipEnv, roomId, 'v2.scrapyard-dev.ticket'), 'http://51.195.60.60.sslip.io:32123/match')
})
test('without a service binding, Rooms is reached over its public origin', async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (request) => {
    seen.push(request.url)
    return Response.json({ roomId, state: 'live', playerToken: 'signed', server: { host: 'game.example', ports: { game: 32123 } } })
  }
  try {
    const { ROOMS, ...noBinding } = env
    assert.equal(await gameTarget(noBinding, roomId, 'v2.scrapyard-dev.ticket'), 'http://game.example:32123/match')
    assert.deepEqual(seen, [`https://rooms.example/v1/rooms/${roomId}?ticket=v2.scrapyard-dev.ticket`])
  } finally {
    globalThis.fetch = realFetch
  }
})
