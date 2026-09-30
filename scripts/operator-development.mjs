// Dev-only operator helper. Credentials stay in an ignored mode-0600 file or
// subprocess stdin; never argv/stdout. Requires the authorized dev kubectl context.
import { randomBytes } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve('.gameye-rooms')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const file = resolve(directory, 'development-operator.json')
const command = process.argv[2]
if (!existsSync(file) && command !== 'secrets') throw new Error('Missing local operator credentials; provision or restore them before continuing')
if (!existsSync(file)) writeFileSync(file, JSON.stringify({
  PLATFORM_ADMIN_TOKEN: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
}), { mode: 0o600, flag: 'wx' })
const state = JSON.parse(readFileSync(file, 'utf8'))
const save = () => writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
const origin = process.env.ROOMS_ORIGIN
const roomsCheckout = process.env.ROOMS_CHECKOUT
async function request(path, body) {
  if (!origin?.startsWith('https://gameye-rooms-planz-development.')) throw new Error('Explicit development ROOMS_ORIGIN required')
  const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${state.PLATFORM_ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const raw = error.code ?? error.error
    const code = typeof raw === 'string' && /^[a-z0-9_]+$/.test(raw) ? raw : 'unknown'
    throw new Error(`Operator request ${path} returned ${response.status} (${code})`)
  }
  return response.json()
}
if (command === 'secrets') {
  if (!roomsCheckout) throw new Error('ROOMS_CHECKOUT required')
  const result = spawnSync('node', [resolve(roomsCheckout, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', '--env', 'planz-development'], {
    cwd: roomsCheckout, input: JSON.stringify({ PLATFORM_ADMIN_TOKEN: state.PLATFORM_ADMIN_TOKEN, ENCRYPTION_KEY: state.ENCRYPTION_KEY }),
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.status) process.exit(result.status)
} else if (command === 'bootstrap') {
  if (!roomsCheckout) throw new Error('ROOMS_CHECKOUT required')
  const status = await request('/v1/platform/capacity')
  if (status.sealed) { console.log('Capacity ledger already sealed'); process.exit(0) }
  const { bootstrap } = await import(pathToFileURL(resolve(roomsCheckout, 'scripts/platform-capacity.mjs')))
  const result = await bootstrap({ base: origin, token: state.PLATFORM_ADMIN_TOKEN, generation: 'scrapyard-development-v1' }, true)
  console.log(JSON.stringify({ sealed: result.sealed, tenants: result.tenants }))
} else if (command === 'gameye-token') {
  if (state.gameyeApiToken) { console.log('Dev Gameye token already stored'); process.exit(0) }
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
  const tenantId = process.env.ROOMS_TENANT || 'scrapyard-dev'
  if (!/^scrapyard-[a-z0-9-]+$/.test(tenantId)) throw new Error('Expected a scrapyard development tenant slug')
  const tenantFile = resolve(directory, `${tenantId}-tenant.json`)
  if (existsSync(tenantFile)) { console.log('Tenant already onboarded; credentials are saved'); process.exit(0) }
  const config = JSON.parse(readFileSync('deployment/tenant-config.json', 'utf8'))
  if (JSON.stringify(config).includes('REPLACE')) throw new Error('Tenant config contains placeholders')
  const result = await request('/v1/tenant', { tenantId, gameyeApiToken: state.gameyeApiToken, config })
  writeFileSync(tenantFile, JSON.stringify(result), { mode: 0o600, flag: 'wx' })
  console.log('Tenant onboarded; credentials saved securely')
} else if (command === 'status') {
  const status = await request('/v1/platform/capacity')
  console.log(JSON.stringify({ sealed: status.sealed, limits: status.limits, providerSessions: status.providerSessions }))
} else throw new Error('Usage: operator-development.mjs secrets|bootstrap|gameye-token|onboard|status')
