// Every request is bounded; only route names/status are logged, never credentials.
export class RoomsLifecycle {
  private pending = Promise.resolve()
  private url: string
  private matchId: string
  private token: string
  constructor(url: string, matchId: string, token: string) {
    this.url = url; this.matchId = matchId; this.token = token
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error('MM_URL requires HTTPS')
  }

  async send(path: string, body: Record<string, unknown> = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(`${this.url}${path}`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ matchId: this.matchId, ...body }),
        })
        await response.body?.cancel()
        if (response.ok) return
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new PermanentCallbackError()
      } catch (error) {
        if (error instanceof PermanentCallbackError) throw new Error(`Rooms ${path} rejected`)
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    }
    throw new Error(`Rooms ${path} unavailable`)
  }

  player(uid: string, action: 'joined' | 'left') {
    // Preserve joined/left ordering across a quick disconnect.
    this.pending = this.pending.then(() => this.send(`/players/${uid}/${action}`)).catch(() => {
      console.error(JSON.stringify({ msg: 'Rooms player callback failed', action }))
    })
  }

  async complete(reason: string) {
    await this.pending
    await this.send('/complete', { results: { reason } })
  }
}
class PermanentCallbackError extends Error {}
