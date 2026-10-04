// TLS termination for the browser. Rooms authenticates membership and supplies
// the destination; clients can never select an arbitrary upstream host/port.
/** @param {Response | Request} response */
export async function readJsonBounded(response, limit = 65536) {
  if (!response.body) throw new Error('Missing body')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('Body too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * Rooms reached through a same-account service binding when one is configured,
 * otherwise over its public HTTPS origin (the native OVH deployment).
 * @param {{ ROOMS?: Fetcher }} env
 * @param {Request} request
 */
export function roomsFetch(env, request) {
  return env.ROOMS ? env.ROOMS.fetch(request) : fetch(request)
}

/**
 * @param {Pick<Env, 'ROOMS_ORIGIN' | 'ROOMS_TENANT'> & { ROOMS?: Fetcher, GAMEYE_IPV4_DNS_SUFFIX?: string }} env
 * @param {string} roomId
 * @param {string} ticket
 */
export async function gameTarget(env, roomId, ticket) {
  if (!/^[a-f0-9]{64}$/.test(roomId) || !ticket.startsWith(`v2.${env.ROOMS_TENANT}.`) || ticket.length > 16384) return null
  const response = await roomsFetch(env, new Request(`${env.ROOMS_ORIGIN}/v1/rooms/${roomId}?ticket=${encodeURIComponent(ticket)}`))
  if (!response.ok) { await response.body?.cancel(); return null }
  const room = await readJsonBounded(response)
  if (room.state !== 'live' || !room.playerToken || room.roomId !== roomId) return null
  const host = room.server?.host
  const port = room.server?.ports?.game
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  // Cloudflare fetch rejects bare-IP origins. The development wildcard DNS
  // maps the provider-allocated IPv4 to a hostname; callers cannot set it.
  let hostname = host
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && env.GAMEYE_IPV4_DNS_SUFFIX) {
    if (host.split('.').some((p) => Number(p) > 255) || !/^[a-z0-9.-]+$/i.test(env.GAMEYE_IPV4_DNS_SUFFIX)) return null
    hostname = `${host}.${env.GAMEYE_IPV4_DNS_SUFFIX}`
  }
  return `http://${hostname}:${port}/match`
}

/** @type {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/rooms/')) {
        const path = url.pathname.slice('/rooms'.length)
        const allowed = (request.method === 'POST' && ['/v1/tickets', '/v1/queue'].includes(path)) ||
          (['GET', 'DELETE'].includes(request.method) && /^\/v1\/queue\/[^/]+$/.test(path)) ||
          (request.method === 'GET' && /^\/v1\/rooms\/[a-f0-9]{64}$/.test(path)) ||
          (request.method === 'POST' && /^\/v1\/rooms\/[a-f0-9]{64}\/leave$/.test(path))
        if (!allowed) return new Response('Not found', { status: 404 })
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return new Response('Origin refused', { status: 403 })
        const headers = new Headers({ 'content-type': 'application/json' })
        const ip = request.headers.get('CF-Connecting-IP')
        if (ip) headers.set('CF-Connecting-IP', ip)
        /** @type {BodyInit | null} */
        let body = request.body
        if (path === '/v1/tickets') {
          const input = await readJsonBounded(request, 8192)
          if (input.tenantId !== env.ROOMS_TENANT) return new Response('Unknown tenant', { status: 400 })
          body = JSON.stringify(input)
        }
        const response = await roomsFetch(env, new Request(`${env.ROOMS_ORIGIN}${path}${url.search}`, { method: request.method, headers, body, redirect: 'manual' }))
        return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      }
      const game = url.pathname.match(/^\/game\/([a-f0-9]{64})$/)
      if (game) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
        if (request.headers.get('origin') !== url.origin) return new Response('Origin refused', { status: 403 })
        const target = await gameTarget(env, game[1], url.searchParams.get('ticket') || '')
        if (!target) return new Response('Match unavailable', { status: 403 })
        const headers = new Headers({ Upgrade: 'websocket', Origin: url.origin })
        const response = await fetch(target, { headers, redirect: 'manual' })
        if (response.status !== 101) {
          console.error(JSON.stringify({ event: 'game_upstream_refused', status: response.status }))
          await response.body?.cancel()
          return new Response('Game server unavailable', { status: 502, headers: { 'x-game-upstream-status': String(response.status) } })
        }
        // Pass through the upgrade without accepting/re-emitting game messages.
        return response
      }
      return env.ASSETS.fetch(request)
    } catch {
      console.error(JSON.stringify({ event: 'scrapyard_gateway_error' }))
      return new Response('Temporarily unavailable', { status: 502 })
    }
  },
}
