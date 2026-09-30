import type { Loadout } from '../game/loadout'
import { join, openSocket, type Link } from './connection'
import { gameSocketUrl, roomSnapshot, roomsRequest, type Admission, type Ticket } from './rooms'

export type Search =
  | { phase: 'idle'; note: string }
  | { phase: 'connecting'; mode: string }
  | { phase: 'searching'; mode: string; since: number; note: string; away: '' | 'dropped' }
  | { phase: 'seated'; link: Link }
let state: Search = { phase: 'idle', note: '' }
const listeners = new Set<() => void>()
let attempt = 0
let cleanup: (() => Promise<void>) | null = null
const tenantId = import.meta.env.VITE_ROOMS_TENANT || 'scrapyard-dev'
const playlist = 'ffa-scrapyard'
export const currentSearch = () => state
export function onSearch(fn: () => void) { listeners.add(fn); return () => void listeners.delete(fn) }
function set(next: Search) { state = next; for (const fn of listeners) fn() }
// A reload starts a fresh guest; existing allocations expire through managed lifecycle.
export function resumeSearch(_loadout: Loadout) {}

export async function findMatch(mode: string, loadout: Loadout) {
  if (state.phase !== 'idle') return
  if (mode !== 'ffa') { set({ phase: 'idle', note: 'Online dev test: Free For All. Team Deathmatch is available in Practice.' }); return }
  const mine = ++attempt
  set({ phase: 'connecting', mode })
  let release: (() => Promise<void>) | null = null
  try {
    const ticket = await roomsRequest<Ticket>('/v1/tickets', 'POST', { tenantId })
    if (mine !== attempt) return
    const admission = await roomsRequest<Admission>('/v1/queue', 'POST', { ticket: ticket.ticket, playlist })
    let roomId = admission.roomId
    release = async () => {
      if (roomId) await roomsRequest(`/v1/rooms/${roomId}/leave`, 'POST', { ticket: ticket.ticket })
      else await roomsRequest(`/v1/queue/${encodeURIComponent(admission.queueId)}`, 'DELETE')
    }
    if (mine !== attempt) { await release().catch(() => undefined); return }
    cleanup = release
    const since = performance.now()
    while (mine === attempt) {
      if (performance.now() - since > 180_000) throw new Error('No ready server after three minutes. Please retry.')
      if (!roomId) {
        const queue = await roomsRequest<Admission>(`/v1/queue/${encodeURIComponent(admission.queueId)}`)
        roomId = queue.roomId
      }
      if (roomId) {
        const snapshot = await roomSnapshot(roomId, ticket.ticket)
        if (mine !== attempt) return
        if (snapshot.state === 'closed') throw new Error(`Match closed: ${snapshot.closedReason || 'please retry'}`)
        if (snapshot.state === 'live' && snapshot.playerToken && snapshot.server) {
          const socket = await openSocket(gameSocketUrl(roomId, ticket.ticket))
          if (mine !== attempt) { socket.close(); return }
          const link = await join(socket, { token: snapshot.playerToken, guest: true, mode: 'ffa', map: 'scrapyard', loadout })
          if (mine !== attempt) { link.close(); return }
          cleanup = null
          set({ phase: 'seated', link })
          return
        }
        set({ phase: 'searching', mode, since, away: '', note: `${snapshot.state} · ${snapshot.members.length}/8 players` })
      } else set({ phase: 'searching', mode, since, away: '', note: 'Waiting for players' })
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  } catch (error) {
    await release?.().catch(() => undefined)
    if (mine === attempt) { cleanup = null; set({ phase: 'idle', note: error instanceof Error ? error.message : 'Unable to join' }) }
  }
}

export function cancelSearch() {
  attempt++
  const release = cleanup
  cleanup = null
  void release?.().catch(() => undefined)
  set({ phase: 'idle', note: 'Search cancelled' })
}
export function takeSeat(): Link | null {
  if (state.phase !== 'seated') return null
  const link = state.link
  set({ phase: 'idle', note: '' })
  return link
}
