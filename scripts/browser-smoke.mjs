// Optional operator check: PLAYWRIGHT_MODULE may point at an installed Playwright.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.SCRAPYARD_URL || 'https://scrapyard-gameye-dev.andrew-48d.workers.dev'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] })
try {
  const players = []
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const state = { welcome: null, snapshots: 0, errors: 0 }
    page.on('pageerror', () => { state.errors++ })
    page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload))
        if (message.t === 'welcome') state.welcome = { room: message.room, seat: message.seat }
        if (message.t === 's') state.snapshots++
      } catch { /* ignore non-game frames */ }
    }))
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^play/i }).click()
    await page.getByRole('button', { name: 'Free for All', exact: true }).click()
    await page.getByRole('button', { name: /^Gameye Rooms/i }).click()
    players.push({ page, state })
  }
  const deadline = Date.now() + 120000
  while (Date.now() < deadline && !players.every((p) => p.state.welcome && p.state.snapshots > 90)) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(players.every((p) => p.state.welcome && p.state.snapshots > 90), 'Both browsers must join and receive gameplay snapshots')
  assert.equal(players[0].state.welcome.room, players[1].state.welcome.room)
  assert.notEqual(players[0].state.welcome.seat, players[1].state.welcome.seat)
  for (const { page } of players) {
    await page.keyboard.down('w')
    await page.waitForTimeout(1500)
    await page.keyboard.up('w')
  }
  console.log(JSON.stringify({ result: 'BROWSER SMOKE PASS', players: players.map(({ state }) => ({ seat: state.welcome.seat, snapshots: state.snapshots, pageErrors: state.errors })) }))
  assert.ok(players.every((p) => p.state.errors === 0), 'No browser script errors')
} finally { await browser.close() }
