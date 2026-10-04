// Dev-only operator helper for the native gameye-rooms matchmaker on OVH.
// Credentials stay in an ignored mode-0600 file or come in on stdin; never
// argv/stdout. `gameye-token` requires the authorized dev kubectl context.
// Platform routes are allowlisted by source address on the Rooms server, so
// `status` only works from the operator's allowlisted address.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: operator-development.mjs token|gameye-token|onboard|set-image <sha-tag>|status'
const RETIRED = 'was for the retired Cloudflare Rooms Worker. The OVH server provisions its own secrets and capacity ledger; see docs/ovh-native-runbook.md in Gameye/rooms-matchmaker.'
const IMAGE_TAG = /^sha-[0-9a-f]{40}$/
const TENANT = /^scrapyard-[a-z0-9-]+$/

/** The Rooms origin: ROOMS_ORIGIN when set, else the one pinned in wrangler.jsonc. Always https. */
export function roomsOrigin(env, wranglerText) {
  const pinned = /"ROOMS_ORIGIN"\s*:\s*"([^"]+)"/.exec(wranglerText)?.[1]
  const origin = (env.ROOMS_ORIGIN || pinned || '').replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) throw new Error('ROOMS_ORIGIN must be an https origin (set it, or pin it in wrangler.jsonc)')
  return origin
}

export function tenantSlug(env) {
  const tenantId = env.ROOMS_TENANT || 'scrapyard-dev'
  if (!TENANT.test(tenantId)) throw new Error('Expected a scrapyard development tenant slug')
  return tenantId
}

export function imageTag(tag) {
  if (!IMAGE_TAG.test(tag ?? '')) throw new Error('Image tag must be sha-<full 40-character commit>')
  return tag
}

/** Calls Rooms with the platform token; errors carry only the status and a safe error code. */
export function roomsClient(origin, token, fetchImpl = fetch) {
  return async function request(method, path, body) {
    const response = await fetchImpl(`${origin}${path}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const raw = payload.code ?? payload.error
      const code = typeof raw === 'string' && /^[a-z0-9_]+$/.test(raw) ? raw : 'unknown'
      const error = new Error(`Operator request ${path} returned ${response.status} (${code})`)
      error.status = response.status
      error.code = code
      throw error
    }
    return payload
  }
}

/**
 * Move a tenant to a new image tag in place. The first attempt asks Gameye to
 * enable the tag; Rooms answers 409 image_version_not_ready (leaving the tenant
 * unchanged) until Gameye has pulled it, so retry until it succeeds.
 */
export async function setImage(request, tenantId, tag, { attempts = 30, delayMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const body = attempt === 1 ? { imageVersion: tag, enableTag: true } : { imageVersion: tag }
      return await request('PATCH', `/v1/tenant/${encodeURIComponent(tenantId)}`, body)
    } catch (err) {
      if (err.code !== 'image_version_not_ready' || attempt >= attempts) throw err
      log(`Gameye has not pulled ${tag} yet (attempt ${attempt}); retrying`)
      await sleep(delayMs)
    }
  }
}

async function main(command, arg) {
  const directory = resolve('.gameye-rooms')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = resolve(directory, 'development-operator.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const save = () => writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  const origin = () => roomsOrigin(process.env, readFileSync('wrangler.jsonc', 'utf8'))
  const request = () => {
    if (!state.PLATFORM_ADMIN_TOKEN) throw new Error('No platform token stored; run `operator-development.mjs token` with it on stdin')
    return roomsClient(origin(), state.PLATFORM_ADMIN_TOKEN)
  }

  if (command === 'token') {
    const token = readFileSync(0, 'utf8').trim()
    if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(token)) throw new Error('Expected the Rooms platform token on stdin')
    state.PLATFORM_ADMIN_TOKEN = token
    save()
    console.log('Platform token stored securely')
  } else if (command === 'secrets' || command === 'bootstrap') {
    throw new Error(`\`${command}\` ${RETIRED}`)
  } else if (command === 'gameye-token') {
    if (state.gameyeApiToken) { console.log('Dev Gameye token already stored'); return }
    const userId = process.env.GAMEYE_USER_ID
    if (!userId || !/^[a-f0-9-]{36}$/.test(userId)) throw new Error('GAMEYE_USER_ID must identify the dev organization user')
    const program = `(async()=>{const r=await fetch("http://orchestrator:8081/api/v2/tokens",{method:"POST",headers:{Authorization:"Bearer "+process.env.API_MANAGEMENT_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({id:${JSON.stringify(userId)},name:"scrapyard-rooms-dev",scopes:["regions:read","session:start","session:read","session:stop"]})});if(r.status!==201)throw new Error("Token creation failed: "+r.status);process.stdout.write(JSON.stringify(await r.json()))})().catch(()=>{process.stderr.write("Token creation failed");process.exit(1)})`
    const output = execFileSync('kubectl', ['--context=gke_planz-development_europe-west1_planz-development-gke', 'exec', 'deployment/admin-bff', '-n', 'default', '--', 'node', '-e', program], { encoding: 'utf8' })
    const result = JSON.parse(output)
    if (!result.token) throw new Error('Missing token')
    state.gameyeApiToken = result.token; save()
    console.log('Scoped development Gameye token stored securely')
  } else if (command === 'onboard') {
    if (!state.gameyeApiToken) throw new Error('Create development Gameye token first')
    const tenantId = tenantSlug(process.env)
    const tenantFile = resolve(directory, `${tenantId}-tenant.json`)
    if (existsSync(tenantFile)) { console.log('Tenant already onboarded; credentials are saved'); return }
    const config = JSON.parse(readFileSync('deployment/tenant-config.json', 'utf8'))
    if (JSON.stringify(config).includes('REPLACE')) throw new Error('Tenant config contains placeholders')
    const result = await request()('POST', '/v1/tenant', { tenantId, gameyeApiToken: state.gameyeApiToken, config })
    writeFileSync(tenantFile, JSON.stringify(result), { mode: 0o600, flag: 'wx' })
    console.log('Tenant onboarded; credentials saved securely')
  } else if (command === 'set-image') {
    const tenantId = tenantSlug(process.env)
    const result = await setImage(request(), tenantId, imageTag(arg), { log: (line) => console.log(line) })
    console.log(JSON.stringify({ tenantId, imageVersion: result.imageVersion, changed: result.changed, readyRegions: result.availability?.readyRegions }))
  } else if (command === 'status') {
    const status = await request()('GET', '/v1/platform/capacity')
    console.log(JSON.stringify({ sealed: status.sealed, drain: status.drain, limits: status.limits, providerSessions: status.providerSessions, counts: status.counts }))
  } else throw new Error(USAGE)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2], process.argv[3])
}
