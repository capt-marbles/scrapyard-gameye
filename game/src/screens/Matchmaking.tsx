import { cancelSearch } from '../net/matchmaking'
import { useSearch } from './search'

export function Matchmaking({ inGame }: { arena: boolean; inGame: boolean }) {
  const search = useSearch()
  const active = search.phase === 'connecting' || search.phase === 'searching'
  const note = search.phase === 'idle' || search.phase === 'searching' ? search.note : ''
  if (!active && !note) return null
  return (
    <div role="status" className={`fixed z-30 flex items-center gap-3 rounded border border-white/15 bg-black/80 px-4 py-3 text-sm text-neutral-100 ${inGame ? 'top-6 right-6' : 'bottom-6 left-1/2 -translate-x-1/2'}`}>
      <span>{search.phase === 'connecting' ? 'Connecting to Gameye Rooms…' : note}</span>
      {active && <button className="text-red-400" onClick={cancelSearch}>Cancel</button>}
    </div>
  )
}
