export interface Ticket { playerId: string; ticket: string; expiresAt: string }
export interface Admission { queueId: string; roomId: string | null }
export interface RoomSnapshot {
  roomId: string; state: string; closedReason?: string; requeue?: boolean
  members: Array<{ playerId: string; team: number }>
  playerToken?: string; server?: { host: string; ports: Record<string, number> } | null
}
export async function roomsRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/rooms${path}`, {
    method, signal: AbortSignal.timeout(15_000),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`Matchmaking request failed (${response.status}). Please retry.`)
  return response.json() as Promise<T>
}
export const roomSnapshot = (roomId: string, ticket: string) => roomsRequest<RoomSnapshot>(`/v1/rooms/${encodeURIComponent(roomId)}?ticket=${encodeURIComponent(ticket)}`)
export function gameSocketUrl(roomId: string, ticket: string) {
  const url = new URL(`/game/${encodeURIComponent(roomId)}`, location.origin)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}
