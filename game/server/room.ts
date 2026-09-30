import { randomBytes } from 'node:crypto'
import { botGun, createBrain, DIFFICULTIES } from '../src/game/ai'
import { armWeapon, WEAPONS } from '../src/game/combat'
import type { Loadout } from '../src/game/loadout'
import type { Arena } from '../src/game/arena/arena'
import type { MapId } from '../src/game/maps'
import { MODES, type Mode } from '../src/game/modes'
import { createWorld, PHYSICS_STEP } from '../src/game/physics'
import { botName, recruits } from '../src/game/roster'
import { createSimulation, enlist, type Combatant } from '../src/game/simulation'
import { arenaDigest } from '../src/game/arena/digest'
import { carRow, clampAim, clampView, meRow, PROTOCOL, RATE, statsRow, weaponId, acceptSeq, type ErrorCode, type Input, type ServerMessage } from '../src/net/protocol'
import { arenaData } from './arenas'
import { createRecorder } from './recorder'
import { createRewind } from './rewind'

// One online match: its own physics world, the line-up (roster.ts — bots in
// every seat until people take them over), the running mode, and the very
// simulation a practice match runs, stepped by the server's loop. People
// only ever send controls: each step a seat's next input is written into
// its machine's controls, and the simulation decides the rest. Every second
// step the room tells everyone what happened (a snapshot); the rules' state
// goes out when it changes. When the mode says the match is over, everyone
// stands down; after the results the next match starts with a fresh seed.
// A room matchmaking made (lobby.ts) holds its first match until every
// person seated has loaded it — their page's first input — or `hold` runs
// out: nothing moves meanwhile, and a seat whose page is late is its bot's
// until it comes (the takeover, as for anyone joining).

export const SKILL = DIFFICULTIES.normal // the bots' online
const QUEUE = 6 // inputs kept per player; past this the oldest go (latency capped)
// A drain window, in steps. A stall on the way leaves a burst of inputs
// queued, and while the page keeps pace nothing would ever empty the queue
// again: every input after waits that much longer, and the tick it says it
// saw ages against the rewind's 200 ms (measured: 4–5 deep for good after
// the first stall, NET_LOG.md). So inputs that waited through a whole window
// — beyond one kept for the jitter — are standing delay, not jitter, and are
// let go at the window's end (drops: one correction's worth). A queue that
// ran down to one or none in the window is absorbing jitter, and is left alone.
const DRAIN = 30
const STALE = 250 // ms without input: the machine coasts, trigger off
const IDLE = 60_000 // ms without input: the player is let go and a bot takes the seat
const SHARE = 12 // steps between checks for a changed rules state
const NEUTRAL = { throttle: 0, steer: 0, handbrake: false, fire: false, recover: false }
const STAND_DOWN = { ...NEUTRAL, handbrake: true }

const freshSeed = () => randomBytes(4).readUInt32LE(0)

// A person in a seat.
export interface Human {
  uid: string
  name: string
  seat: number
  send(text: string): void // a message, serialised
  close(code: ErrorCode, text: string): void // let the player go (the socket closes; the lobby frees the seat)
  queue: Input[]
  last: Input | null // repeated while the queue is dry; null until the first: a bot still drives the machine
  repeats: number // steps that had to repeat the last input (the queue ran dry)
  drops: number // inputs let go unused (the queue grew too long)
  depths: number[] // steps by how many inputs still waited after the step took its own: 0..QUEUE
  low: number // the fewest inputs waiting after a step, this drain window
  window: number // steps into it
  seq: number // the newest seq taken in
  ack: number // the last seq used on a step
  heardAt: number // ms: when the latest input arrived
  view: number // the tick the player last said it sees (clamped)
}

// How deep a person's input queue ran, step by step: each queued input is a
// step (17 ms) more between their keys and their machine, and a step less of
// the rewind's 200 ms for their aim.
export function queueDepth(human: Human) {
  const total = human.depths.reduce((sum, n) => sum + n, 0)
  const at = (share: number) => {
    let seen = 0
    for (const [depth, n] of human.depths.entries()) if ((seen += n) >= share * total) return depth
    return 0
  }
  return { p50: at(0.5), p95: at(0.95), max: human.depths.findLastIndex((n) => n > 0) }
}

export interface RoomOptions {
  id: string
  mode: Mode
  map: MapId
  build?: string // the pages' build: matchmaking offers its bot seats to pages of the same one
  hold?: number // steps the first match waits at most for the people seated to load it (a room made from a proposal)
  seed?: number // a fixed first seed (checks); fresh from node:crypto otherwise
  results?: number // seconds the results stay up before the next match
  arena?: Arena // played on instead of the map's own (the netplay check's test yard)
  log?: (message: string, fields: Record<string, unknown>) => void
  onComplete?: () => void // managed mode: complete once instead of cycling into another match
}

export type Room = ReturnType<typeof createRoom>

export function createRoom({ id, mode: kind, map, build = '', hold = -1, seed: first, results = 15, arena = arenaData(map), log = () => {}, onComplete }: RoomOptions) {
  let seed = first ?? freshSeed()
  const digest = arenaDigest(arena)
  const world = createWorld(arena.colliders)
  const combatants = recruits(kind, arena, seed, SKILL).map((recruit, i) => enlist(world, i, recruit))
  const mode = MODES[kind].create({ combatants, arena, world, seed })
  let tick = 0
  const recorder = createRecorder(() => tick)
  const humans: Human[] = []
  const rewind = createRewind(world, combatants)
  const flags = { compensate: true } // lag compensation for people's hitscan (the netplay check turns it off to compare)
  // A person's round meets the others where that person's page drew them;
  // a bot's (a seat's bot too, until its person's first input), or one seen
  // in the present, is cast as it stands.
  const sim = createSimulation({
    world,
    arena,
    combatants,
    mode,
    events: recorder.sim,
    seed,
    castRound(c, muzzle, shot, random) {
      if (!flags.compensate) return false
      const human = humans.find((h) => h.seat === c.id)
      return !!human?.last && human.view < tick - 1 && rewind.cast(c, muzzle, human.view, shot, random)
    },
  })
  let next = -1 // the tick the next match starts at, once this one is over
  let completed = false
  const full = mode.rules.remaining() // seconds on a match's clock
  let changed = true // the rules had events since the state last went out
  let sharedAt = -Infinity
  let lastState = ''
  let emptySince = 0 // ms
  const steps = { count: 0, total: 0, max: 0, recent: new Float64Array(3600) } // ms per step, the last minute kept

  const send = (to: Human, message: ServerMessage) => to.send(JSON.stringify(message))
  const lineUp = () => combatants.map((c) => ({ name: c.name, team: c.team, vehicle: c.vehicle, weapon: weaponId(c.weapon.spec), human: humans.some((h) => h.seat === c.id) }))

  // --- the step ------------------------------------------------------------------------------

  function step(now: number) {
    tick++
    if (hold >= 0 && (tick >= hold || humans.every((h) => h.last))) release()
    const live = next < 0
    for (const human of humans) drive(human, now, live && hold < 0)
    if (hold < 0) {
      const started = performance.now()
      sim.step(PHYSICS_STEP, live)
      time(performance.now() - started)
    }
    rewind.record(tick)
    if (mode.rules.events.length) {
      recorder.rules(mode.rules.events)
      changed = true
    }
    mode.report() // drains the rules' events; each browser announces them for its own player
    if (live) {
      if (mode.outcome() !== undefined) finish()
    } else if (tick >= next && !completed) {
      if (onComplete) { completed = true; onComplete() }
      else restart()
    }
    if (tick % (RATE.step / RATE.snap) === 0) broadcast()
    for (const human of humans) if (now - human.heardAt > IDLE) human.close('idle', 'No input for a minute')
  }

  // The seat's next input into its machine's controls (the last one again
  // while none has come); neutral once the input is stale, standing down once
  // the match is over. Before the page's first input the bot drives on.
  function drive(human: Human, now: number, live: boolean) {
    const c = combatants[human.seat]
    const input = human.queue.shift()
    if (input) {
      if (!human.last) takeWheel(c)
      human.last = input
      human.ack = input.seq
    } else if (human.last) human.repeats++
    human.low = Math.min(human.low, human.queue.length)
    if (++human.window >= DRAIN) {
      const slack = Math.max(0, human.low - 1)
      human.queue.splice(0, slack)
      human.drops += slack
      human.low = Infinity
      human.window = 0
    }
    human.depths[human.queue.length]++
    const use = human.last
    if (!use) return
    if (!live) return void Object.assign(c.control, STAND_DOWN)
    if (now - human.heardAt > STALE) return void Object.assign(c.control, NEUTRAL)
    Object.assign(c.control, { throttle: use.throttle, steer: use.steer, handbrake: use.handbrake, fire: use.fire, recover: use.recover })
    clampAim(c.control.aim.copy(use.aim), c.position, c.weapon.spec.range)
    human.view = clampView(use.view, tick)
  }

  // The first match goes: everyone's page is in, or the wait is over (a late
  // page's seat is its bot's until the page's first input).
  function release() {
    const late = humans.filter((h) => !h.last)
    if (late.length) log('load timeout', { room: id, map, late: late.map((h) => h.uid), humans: humans.length })
    hold = -1
    changed = true
  }

  function time(ms: number) {
    steps.recent[steps.count % steps.recent.length] = ms
    steps.count++
    steps.total += ms
    steps.max = Math.max(steps.max, ms)
  }

  // The mode has a result: everyone stands down, the results run.
  function finish() {
    sim.standDown()
    next = tick + results * RATE.step
    changed = true
  }

  // The next match, on the same arena and machines, with a fresh seed.
  function restart() {
    seed = freshSeed()
    recorder.restart(seed)
    sim.restart(seed)
    mode.restart(seed)
    next = -1
    changed = true
  }

  // --- what everyone is told -------------------------------------------------------------------

  // The snapshot: the machines and the events since the last one, written
  // once and wrapped with each player's own ack and machine.
  function broadcast() {
    const events = recorder.drain()
    if (!humans.length) return
    const shared = `"k":${tick},"now":${Math.round(mode.rules.now * 1000)},"cars":${JSON.stringify(combatants.map(carRow))},"ev":${JSON.stringify(events)}`
    for (const human of humans) human.send(`{"t":"s","ack":${human.ack},"me":${JSON.stringify(meRow(combatants[human.seat]))},${shared}}`)
    if (changed || tick - sharedAt >= SHARE) share()
  }

  // The rules' state and everyone's statistics, when they changed (or to one
  // player who has just joined).
  function share(to?: Human) {
    const body = JSON.stringify({ next, hold, rules: mode.share(), stats: combatants.map((c) => statsRow(c.stats)) })
    changed = false
    sharedAt = tick
    if (!to && body === lastState) return
    if (!to) lastState = body
    const text = `{"t":"st","k":${tick},${body.slice(1)}`
    for (const human of to ? [to] : humans) human.send(text)
  }

  // --- seats ----------------------------------------------------------------------------------

  // A bot's seat for a newcomer: on the side with the fewest people (team
  // deathmatch evens the teams; in free for all every machine is its own
  // side), the lowest seat first. -1 when people hold every seat.
  function freeSeat() {
    const people = (team: number) => humans.filter((h) => combatants[h.seat].team === team).length
    let best = -1
    for (const c of combatants) {
      if (humans.some((h) => h.seat === c.id)) continue
      if (best < 0 || people(c.team) < people(combatants[best].team)) best = c.id
    }
    return best
  }

  // A person takes a bot's machine where it stands, with their name and
  // their gun; the seat keeps its statistics. The bot keeps the wheel until
  // the page's first input: from the welcome on, the page still builds its
  // match and compiles its shaders (seconds, on a slow machine), and a machine
  // nobody drives would sit there under fire. Until then the gun is a bot's
  // copy of theirs (the same gun, as the welcome says, scaled as bots' are).
  // Only the gun is theirs: the hello's vehicle is read (and checked) but
  // not used — every seat keeps the roster's machine. VEHICLES has one entry
  // today; server.check fails the day it has two, until a person is seated
  // in the vehicle they chose.
  function join(person: { uid: string; name: string; loadout: Loadout; send: Human['send']; close: Human['close'] }, now: number): Human | null {
    const seat = freeSeat()
    if (seat < 0) return null
    const c = combatants[seat]
    c.weapon = armWeapon(botGun(WEAPONS[person.loadout.weapon], SKILL))
    c.name = person.name
    const human: Human = { uid: person.uid, name: person.name, seat, send: person.send, close: person.close, queue: [], last: null, repeats: 0, drops: 0, depths: new Array<number>(QUEUE + 1).fill(0), low: Infinity, window: 0, seq: -1, ack: -1, heardAt: now, view: tick }
    humans.push(human)
    send(human, { t: 'welcome', v: PROTOCOL, room: id, seat, mode: kind, map, seed, tick, rate: RATE, digest, lineUp: lineUp() })
    share(human)
    for (const other of humans) if (other !== human) send(other, { t: 'ro', seat, name: c.name, human: true, weapon: weaponId(c.weapon.spec) })
    return human
  }

  // The page's first input: the bot lets go and the person drives, their gun
  // at its full rating (its ammo and reload as the bot left them).
  function takeWheel(c: Combatant) {
    c.brain = undefined
    c.weapon = { ...c.weapon, spec: WEAPONS[weaponId(c.weapon.spec)] }
  }

  // The person is gone: a bot drives their machine on, with its own name and a bot's gun.
  function leave(human: Human, now: number) {
    const at = humans.indexOf(human)
    if (at < 0) return
    humans.splice(at, 1)
    const c = combatants[human.seat]
    c.brain = createBrain(c.seed, SKILL)
    c.weapon = armWeapon(botGun(WEAPONS[weaponId(c.weapon.spec)], SKILL))
    c.name = botName(c.id)
    for (const other of humans) send(other, { t: 'ro', seat: c.id, name: c.name, human: false, weapon: weaponId(c.weapon.spec) })
    if (!humans.length) emptySince = now
  }

  // An input from `human`: taken in order only, queued for the steps to use.
  function input(human: Human, message: Input, now: number) {
    if (!acceptSeq(human.seq, message.seq)) return false
    human.seq = message.seq
    human.heardAt = now
    human.queue.push(message)
    if (human.queue.length > QUEUE) {
      human.queue.shift()
      human.drops++
    }
    return true
  }

  return {
    id,
    kind, // the mode's id
    map,
    build,
    digest,
    arena,
    world,
    combatants,
    humans,
    mode, // the running mode: its rules
    sim,
    flags,
    rewind, // the poses of the last second
    steps,
    get tick() {
      return tick
    },
    get seed() {
      return seed
    },
    get emptySince() {
      return emptySince
    },
    // The tick the first match stops waiting for its people's pages at the latest; -1 once it doesn't wait.
    get hold() {
      return hold
    },
    // Takes newcomers: a bot seat left, and the match not over.
    open: () => next < 0 && freeSeat() >= 0,
    free: () => combatants.length - humans.length, // bots' seats
    // How far its match has gone: 0 on the grid, 1 at the buzzer (overtime and the results too).
    progress: () => (next >= 0 ? 1 : Math.min(1, Math.max(0, 1 - mode.rules.remaining() / full))),
    step,
    join,
    leave,
    input,
    dispose() {
      mode.dispose()
      world.free()
    },
  }
}
