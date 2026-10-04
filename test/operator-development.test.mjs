import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { imageTag, roomsClient, roomsOrigin, setImage, tenantSlug } from '../scripts/operator-development.mjs'

const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const tag = `sha-${'a'.repeat(40)}`

test('the Rooms origin defaults to the one pinned in wrangler.jsonc, and must be https', () => {
  assert.equal(roomsOrigin({}, wrangler), 'https://137-74-108-96.sslip.io')
  assert.equal(roomsOrigin({ ROOMS_ORIGIN: 'https://rooms.example/' }, wrangler), 'https://rooms.example')
  assert.throws(() => roomsOrigin({ ROOMS_ORIGIN: 'http://rooms.example' }, wrangler))
  assert.throws(() => roomsOrigin({}, '{}'))
})

test('tenant slugs and image tags are validated', () => {
  assert.equal(tenantSlug({}), 'scrapyard-dev')
  assert.throws(() => tenantSlug({ ROOMS_TENANT: 'tin-tanks' }))
  assert.equal(imageTag(tag), tag)
  assert.throws(() => imageTag('sha-abc'))
  assert.throws(() => imageTag(undefined))
})

test('set-image enables the tag first and retries while Gameye pulls it', async () => {
  const calls = []
  let answers = 2
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body), auth: init.headers.authorization })
    if (answers-- > 0) return Response.json({ error: 'image_version_not_ready', message: 'not yet' }, { status: 409 })
    return Response.json({ tenantId: 'scrapyard-dev', imageVersion: tag, changed: true, availability: { verified: true, readyRegions: ['eu-central-1'] } })
  }
  const request = roomsClient('https://rooms.example', 'platform-token', fetchImpl)
  const result = await setImage(request, 'scrapyard-dev', tag, { sleep: async () => {} })
  assert.equal(result.imageVersion, tag)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((c) => [c.method, c.url]), Array(3).fill(['PATCH', 'https://rooms.example/v1/tenant/scrapyard-dev']))
  assert.deepEqual(calls[0].body, { imageVersion: tag, enableTag: true })
  assert.deepEqual(calls[1].body, { imageVersion: tag })
  assert.equal(calls[0].auth, 'Bearer platform-token')
})

test('set-image stops at other errors and after its last attempt, without echoing the response text', async () => {
  const denied = roomsClient('https://rooms.example', 't', async () => Response.json({ error: 'unknown_image_version', message: 'secret-ish detail' }, { status: 422 }))
  await assert.rejects(setImage(denied, 'scrapyard-dev', tag, { sleep: async () => {} }), (err) => err.status === 422 && !err.message.includes('secret-ish'))
  let calls = 0
  const never = roomsClient('https://rooms.example', 't', async () => { calls++; return Response.json({ error: 'image_version_not_ready' }, { status: 409 }) })
  await assert.rejects(setImage(never, 'scrapyard-dev', tag, { attempts: 3, sleep: async () => {} }), (err) => err.code === 'image_version_not_ready')
  assert.equal(calls, 3)
})
