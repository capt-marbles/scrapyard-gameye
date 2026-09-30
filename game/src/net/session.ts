// Guest identity is local to this browser tab. Match admission comes from Rooms.
export interface Player { guest: true; name: string }
export async function player(): Promise<Player> { return { guest: true, name: 'Guest · Gameye Rooms' } }
