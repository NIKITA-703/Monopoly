import { useCallback, useEffect, useRef, useState } from 'react'
import type { LobbyState, OnlineGameEvent, OnlineSession, ServerMessage } from './types'

const sessionStorageKey = 'monopoly.online.session'
const webSocketUrl = () => {
  const configuredUrl = import.meta.env.VITE_WS_URL
  if (configuredUrl) return configuredUrl
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

type ConnectionStatus = 'connecting' | 'password' | 'online' | 'offline'

export function useOnlineLobby() {
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const passwordRef = useRef('')
  const playerIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [lobby, setLobby] = useState<LobbyState | null>(null)
  const [session, setSession] = useState<OnlineSession | null>(null)
  const [error, setError] = useState('')
  const [gameState, setGameState] = useState<{ gameId: string; revision: number; state: unknown } | null>(null)
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null)
  const [turnTimeout, setTurnTimeout] = useState<{ nonce: number; actorId: string | null } | null>(null)
  const [gameEvent, setGameEvent] = useState<{ nonce: string; senderId: string; event: OnlineGameEvent } | null>(null)

  const send = useCallback((message: Record<string, unknown>) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message))
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let reconnectDelay = 500

    const connect = () => {
      if (disposed) return
      setStatus((current) => current === 'password' ? current : 'connecting')
      const socket = new WebSocket(webSocketUrl())
      socketRef.current = socket

      socket.addEventListener('open', () => {
        reconnectDelay = 500
        const token = window.localStorage.getItem(sessionStorageKey)
        if (token) {
          socket.send(JSON.stringify({ type: 'auth', token }))
        } else if (passwordRef.current) {
          socket.send(JSON.stringify({ type: 'auth', password: passwordRef.current }))
        } else {
          setStatus('password')
        }
      })

      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        if (message.type === 'auth_ok') {
          window.localStorage.setItem(sessionStorageKey, message.token)
          passwordRef.current = ''
          setError('')
          setStatus('online')
          return
        }
        if (message.type === 'auth_error') {
          window.localStorage.removeItem(sessionStorageKey)
          setError(message.message)
          setStatus('password')
          return
        }
        if (message.type === 'action_error') {
          setError(message.message)
          return
        }
        if (message.type === 'lobby') {
          playerIdRef.current = message.session?.playerId ?? null
          setLobby(message.lobby)
          setSession(message.session)
          setStatus('online')
          setError('')
          return
        }
        if (message.type === 'game_state') {
          setTurnDeadline(message.turnDeadline)
          // The author already has this optimistic state. Reapplying intermediate
          // echoes makes its dialogs and token briefly jump to an older frame.
          if (!message.senderId || message.senderId !== playerIdRef.current) {
            setGameState(message)
          }
          return
        }
        if (message.type === 'turn_timeout') {
          setTurnTimeout({ nonce: Date.now(), actorId: message.actorId })
          return
        }
        if (message.type === 'game_event') {
          setGameEvent({ nonce: message.eventId, senderId: message.senderId, event: message.event })
        }
      })

      socket.addEventListener('close', () => {
        if (disposed) return
        setStatus('offline')
        reconnectTimerRef.current = window.setTimeout(connect, reconnectDelay)
        reconnectDelay = Math.min(reconnectDelay * 2, 5000)
      })
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
      socketRef.current?.close()
    }
  }, [])

  const authenticate = (password: string) => {
    passwordRef.current = password
    setError('')
    send({ type: 'auth', password })
  }
  const publishGameState = useCallback((state: unknown) => {
    send({ type: 'game_snapshot', state })
  }, [send])

  return {
    status,
    lobby,
    session,
    error,
    gameState,
    turnDeadline,
    turnTimeout,
    gameEvent,
    authenticate,
    claimSeat: (seat: number) => send({ type: 'claim_seat', seat }),
    leaveSeat: () => send({ type: 'leave_seat' }),
    setNickname: (nickname: string) => send({ type: 'set_nickname', nickname }),
    setReady: (ready: boolean) => send({ type: 'set_ready', ready }),
    publishGameState,
    sendChatMessage: (text: string) => send({ type: 'chat_message', text }),
    returnToLobby: () => send({ type: 'return_to_lobby' }),
    sendGameEvent: (event: OnlineGameEvent) => send({ type: 'game_event', event }),
  }
}
