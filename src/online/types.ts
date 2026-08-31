export type LobbySeat = {
  seat: number
  playerId?: string
  nickname: string | null
  ready: boolean
  connected: boolean
  disconnectedExpiresAt: number | null
  idleExpiresAt: number | null
}

export type LobbyState = {
  status: 'lobby' | 'playing'
  gameId: string | null
  countdownEndsAt: number | null
  seats: LobbySeat[]
}

export type OnlineSession = {
  playerId: string
  nickname: string
  seat: number | null
  ready: number | boolean
}

export type OnlineGameEvent =
  | { kind: 'movement'; playerId: string; startPosition: number; steps: number; direction: 1 | -1 }
  | { kind: 'direct-movement'; playerId: string; startPosition: number; destinationPosition: number; speedMultiplier: number }

export type ServerMessage =
  | { type: 'auth_ok'; token: string }
  | { type: 'auth_error'; message: string }
  | { type: 'action_error'; message: string }
  | { type: 'lobby'; lobby: LobbyState; session: OnlineSession }
  | { type: 'game_state'; gameId: string; revision: number; turnDeadline: number | null; senderId?: string | null; state: unknown }
  | { type: 'turn_deadline'; gameId: string; turnDeadline: number | null }
  | { type: 'turn_timeout'; gameId: string; turnKey: string; timeoutId: string; actorId: string | null }
  | { type: 'turn_timeout_granted'; gameId: string; turnKey: string; timeoutId: string; actorId: string | null }
  | { type: 'game_event'; gameId: string; eventId: string; senderId: string; event: OnlineGameEvent }
