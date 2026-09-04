import { useCallback, useEffect, useRef, useState } from 'react'
import type { LobbyState, OnlineGameEvent, OnlineSession, ServerMessage } from './types'
import { playGameSound } from '../audio/gameAudio'

const sessionStorageKey = 'monopoly.online.session'
const persistentSessionStorageKey = 'monopoly.online.player-session'
type GameStateMessage = Extract<ServerMessage, { type: 'game_state' }>
const webSocketUrl = () => {
  const configuredUrl = import.meta.env.VITE_WS_URL
  if (configuredUrl) return configuredUrl
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

type ConnectionStatus = 'connecting' | 'password' | 'online' | 'offline' | 'replaced'

export function useOnlineLobby() {
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const passwordRef = useRef('')
  const playerIdRef = useRef<string | null>(null)
  const passwordScreenRef = useRef(false)
  const sessionEstablishedRef = useRef(false)
  const receivedGameEventIdsRef = useRef(new Set<string>())
  const pendingGameEventIdsRef = useRef(new Set<string>())
  const deferredGameStateRef = useRef<GameStateMessage | null>(null)
  const pendingTimeoutIdRef = useRef<string | null>(null)
  const lastLobbyActivitySentRef = useRef(0)
  const lastImmediateTurnSoundRef = useRef<string | null>(null)
  const lastImmediateTradeSoundRef = useRef<string | null>(null)
  const lastImmediateAuctionSoundRef = useRef<string | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [lobby, setLobby] = useState<LobbyState | null>(null)
  const [session, setSession] = useState<OnlineSession | null>(null)
  const [error, setError] = useState('')
  const [gameState, setGameState] = useState<{ gameId: string; revision: number; state: unknown } | null>(null)
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null)
  const [turnTimeout, setTurnTimeout] = useState<{ timeoutId: string; actorId: string | null } | null>(null)
  const [gameEvents, setGameEvents] = useState<Array<{ nonce: string; senderId: string; event: OnlineGameEvent }>>([])

  const send = useCallback((message: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message))
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let replacedByAnotherTab = false
    let reconnectDelay = 500
    const applyDeferredStateWithoutAnimation = () => {
      if (document.visibilityState !== 'hidden') return
      pendingGameEventIdsRef.current.clear()
      setGameEvents([])
      const deferredState = deferredGameStateRef.current
      deferredGameStateRef.current = null
      if (deferredState) {
        setTurnDeadline(deferredState.turnDeadline)
        setGameState(deferredState)
      }
    }
    document.addEventListener('visibilitychange', applyDeferredStateWithoutAnimation)
    // sessionStorage сохраняет владельца текущей вкладки, а localStorage позволяет
    // вернуть того же игрока после закрытия вкладки или восстановления Chrome.
    const durableToken = window.localStorage.getItem(persistentSessionStorageKey)
      ?? window.localStorage.getItem(sessionStorageKey)
    if (!window.sessionStorage.getItem(sessionStorageKey) && durableToken) {
      window.sessionStorage.setItem(sessionStorageKey, durableToken)
    }
    window.localStorage.removeItem(sessionStorageKey)

    const connect = () => {
      if (disposed || replacedByAnotherTab) return
      setStatus((current) => current === 'password' ? current : 'connecting')
      const socket = new WebSocket(webSocketUrl())
      socketRef.current = socket

      socket.addEventListener('open', () => {
        reconnectDelay = 500
        const token = window.sessionStorage.getItem(sessionStorageKey)
          ?? window.localStorage.getItem(persistentSessionStorageKey)
        if (token) {
          passwordScreenRef.current = false
          socket.send(JSON.stringify({ type: 'auth', token }))
        } else if (passwordRef.current) {
          passwordScreenRef.current = false
          socket.send(JSON.stringify({ type: 'auth', password: passwordRef.current }))
        } else {
          // Общая HttpOnly-cookie подтверждает доступ к комнате, а сервер
          // выдаёт этой вкладке отдельную игровую сессию.
          socket.send(JSON.stringify({ type: 'auth' }))
        }
      })

      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        if (message.type === 'auth_ok') {
          passwordScreenRef.current = false
          window.sessionStorage.setItem(sessionStorageKey, message.token)
          window.localStorage.setItem(persistentSessionStorageKey, message.token)
          passwordRef.current = ''
          setError('')
          setStatus('online')
          return
        }
        if (message.type === 'auth_error') {
          passwordScreenRef.current = true
          window.sessionStorage.removeItem(sessionStorageKey)
          window.localStorage.removeItem(persistentSessionStorageKey)
          setError(message.message)
          setStatus('password')
          return
        }
        if (message.type === 'action_error') {
          setError(message.message)
          return
        }
        if (message.type === 'lobby') {
          sessionEstablishedRef.current = true
          playerIdRef.current = message.session?.playerId ?? null
          setLobby(message.lobby)
          setSession(message.session)
          setStatus('online')
          setError('')
          if (message.lobby.status !== 'playing') {
            receivedGameEventIdsRef.current.clear()
            pendingGameEventIdsRef.current.clear()
            deferredGameStateRef.current = null
            setGameEvents([])
            lastImmediateTurnSoundRef.current = null
            lastImmediateTradeSoundRef.current = null
            lastImmediateAuctionSoundRef.current = null
          }
          return
        }
        if (message.type === 'game_state') {
          const state = message.state as {
            turnSequence?: number
            activePlayerIndex?: number
            players?: Array<{ id: string }>
            winnerId?: string | null
            pendingTileId?: number | null
            pendingPayment?: unknown
            casino?: unknown
            tradeDraft?: {
              stage?: string
              targetPlayerId?: string
              offeredMoney?: number
              requestedMoney?: number
              offeredTileIds?: number[]
              requestedTileIds?: number[]
            } | null
            auction?: {
              tileId: number
              activeBidderId: string
              currentBid: number
              highestBidderId?: string | null
              passedIds?: string[]
            } | null
          }
          const localPlayerId = playerIdRef.current
          if (localPlayerId && !state.winnerId) {
            if (state.tradeDraft?.stage === 'review' && state.tradeDraft.targetPlayerId === localPlayerId) {
              const tradeSoundKey = JSON.stringify([
                state.turnSequence,
                state.tradeDraft.targetPlayerId,
                state.tradeDraft.offeredMoney,
                state.tradeDraft.requestedMoney,
                state.tradeDraft.offeredTileIds,
                state.tradeDraft.requestedTileIds,
              ])
              if (lastImmediateTradeSoundRef.current !== tradeSoundKey) {
                lastImmediateTradeSoundRef.current = tradeSoundKey
                playGameSound('trade')
              }
            } else if (state.auction?.activeBidderId === localPlayerId) {
              const auctionSoundKey = JSON.stringify([
                state.turnSequence,
                state.auction.tileId,
                state.auction.activeBidderId,
                state.auction.currentBid,
                state.auction.highestBidderId,
                state.auction.passedIds,
              ])
              if (lastImmediateAuctionSoundRef.current !== auctionSoundKey) {
                lastImmediateAuctionSoundRef.current = auctionSoundKey
                playGameSound('trade')
              }
            } else if (
              !state.tradeDraft && !state.auction && !state.pendingPayment && !state.casino &&
              state.pendingTileId == null
            ) {
              const actorId = state.players?.[state.activePlayerIndex ?? 0]?.id
              const turnSoundKey = `${state.turnSequence ?? 0}:${actorId ?? 'none'}`
              if (actorId === localPlayerId && lastImmediateTurnSoundRef.current !== turnSoundKey) {
                lastImmediateTurnSoundRef.current = turnSoundKey
                playGameSound('turn')
              }
            }
          }
          // The author already has this optimistic state. Reapplying intermediate
          // echoes makes its dialogs and token briefly jump to an older frame.
          if (message.senderId && message.senderId === playerIdRef.current) {
            setTurnDeadline(message.turnDeadline)
            return
          }
          // Movement and the following snapshots use the same ordered WebSocket
          // stream. Keep only the newest snapshot until every queued animation
          // finishes, so dialogs, money and logs cannot overtake the token.
          if (pendingGameEventIdsRef.current.size > 0) {
            if (document.visibilityState === 'hidden') {
              pendingGameEventIdsRef.current.clear()
              deferredGameStateRef.current = null
              setGameEvents([])
              setTurnDeadline(message.turnDeadline)
              setGameState(message)
              return
            }
            if (!deferredGameStateRef.current || message.revision > deferredGameStateRef.current.revision) {
              deferredGameStateRef.current = message
            }
            return
          }
          setTurnDeadline(message.turnDeadline)
          setGameState(message)
          return
        }
        if (message.type === 'turn_deadline') {
          setTurnDeadline(message.turnDeadline)
          return
        }
        if (message.type === 'turn_timeout') {
          socket.send(JSON.stringify({ type: 'turn_timeout_claim', timeoutId: message.timeoutId }))
          return
        }
        if (message.type === 'turn_timeout_granted') {
          pendingTimeoutIdRef.current = message.timeoutId
          setTurnTimeout({ timeoutId: message.timeoutId, actorId: message.actorId })
          return
        }
        if (message.type === 'game_event') {
          if (
            message.senderId === playerIdRef.current ||
            receivedGameEventIdsRef.current.has(message.eventId)
          ) return
          receivedGameEventIdsRef.current.add(message.eventId)
          if (receivedGameEventIdsRef.current.size > 200) {
            const oldestEventId = receivedGameEventIdsRef.current.values().next().value
            if (oldestEventId) receivedGameEventIdsRef.current.delete(oldestEventId)
          }
          if (document.visibilityState === 'hidden') return
          pendingGameEventIdsRef.current.add(message.eventId)
          setGameEvents((events) => [
            ...events,
            { nonce: message.eventId, senderId: message.senderId, event: message.event },
          ])
        }
      })

      socket.addEventListener('close', (event) => {
        if (disposed) return
        pendingGameEventIdsRef.current.clear()
        deferredGameStateRef.current = null
        setGameEvents([])
        if (event.code === 4002) {
          replacedByAnotherTab = true
          setError('Эта игровая сессия открыта в другой вкладке')
          setStatus('replaced')
          return
        }
        setStatus(passwordScreenRef.current ? 'password' : sessionEstablishedRef.current ? 'offline' : 'connecting')
        reconnectTimerRef.current = window.setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 5000)
      })
    }

    connect()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', applyDeferredStateWithoutAnimation)
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
      socketRef.current?.close()
    }
  }, [])

  const authenticate = async (password: string) => {
    passwordScreenRef.current = false
    passwordRef.current = password
    setError('')
    try {
      const response = await fetch('/api/access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const result = await response.json() as { ok?: boolean; message?: string }
      if (!response.ok || !result.ok) {
        passwordScreenRef.current = true
        passwordRef.current = ''
        setError(result.message ?? 'Неверный пароль')
        setStatus('password')
        return
      }
      send({ type: 'auth', password })
    } catch {
      passwordScreenRef.current = true
      setError('Не удалось связаться с сервером')
      setStatus('password')
    }
  }
  const publishGameState = useCallback((state: unknown) => {
    const timeoutId = pendingTimeoutIdRef.current
    send({ type: 'game_snapshot', state, ...(timeoutId ? { timeoutId } : {}) })
    pendingTimeoutIdRef.current = null
  }, [send])
  const acknowledgeGameEvent = useCallback((eventId: string) => {
    pendingGameEventIdsRef.current.delete(eventId)
    setGameEvents((events) => events.filter((event) => event.nonce !== eventId))
    if (pendingGameEventIdsRef.current.size > 0) return

    const deferredState = deferredGameStateRef.current
    deferredGameStateRef.current = null
    if (deferredState) {
      setTurnDeadline(deferredState.turnDeadline)
      setGameState(deferredState)
    }
  }, [])
  const reportLobbyActivity = useCallback(() => {
    const now = Date.now()
    if (now - lastLobbyActivitySentRef.current < 30000) return
    lastLobbyActivitySentRef.current = now
    send({ type: 'lobby_activity' })
  }, [send])

  return {
    status,
    lobby,
    session,
    error,
    gameState,
    turnDeadline,
    turnTimeout,
    gameEvent: gameEvents[0] ?? null,
    acknowledgeGameEvent,
    authenticate,
    claimSeat: (seat: number) => send({ type: 'claim_seat', seat }),
    leaveSeat: () => send({ type: 'leave_seat' }),
    setNickname: (nickname: string) => send({ type: 'set_nickname', nickname }),
    setReady: (ready: boolean) => send({ type: 'set_ready', ready }),
    reportLobbyActivity,
    publishGameState,
    beginTurnAction: () => send({ type: 'turn_action_started' }),
    sendChatMessage: (text: string) => send({ type: 'chat_message', text }),
    returnToLobby: () => send({ type: 'return_to_lobby' }),
    sendGameEvent: (event: OnlineGameEvent) => send({ type: 'game_event', event }),
  }
}
