import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import App, { type OnlineGameState } from '../App'
import { unlockGameAudio } from '../audio/gameAudio'
import type { Player } from '../types'
import { clientVersion } from '../version'
import './online.css'
import type { LobbySeat } from './types'
import { useOnlineLobby } from './useOnlineLobby'

const playerColors = ['#ff4657', '#28a8ff', '#84d64a', '#b36be8', '#f39a36']

const lobbyPlayers = (seats: LobbySeat[]): Player[] =>
  seats
    .filter((seat): seat is LobbySeat & { playerId: string; nickname: string } => Boolean(seat.playerId && seat.nickname))
    .map((seat) => ({
      id: seat.playerId,
      name: seat.nickname,
      avatar: seat.nickname.trim().charAt(0).toLocaleUpperCase('ru-RU') || String(seat.seat + 1),
      color: playerColors[seat.seat],
      money: 15000,
      position: 0,
      lastDelta: 0,
    }))

function VersionStatus({ serverVersion }: { serverVersion: string | null }) {
  const versionsDiffer = Boolean(serverVersion && serverVersion !== clientVersion)

  return (
    <aside className={`version-status ${versionsDiffer ? 'mismatch' : ''}`} aria-live="polite">
      <span>Monopoly v{clientVersion}</span>
      {serverVersion ? <small>Сервер v{serverVersion}</small> : <small>Версия сервера недоступна</small>}
      {versionsDiffer ? (
        <button type="button" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      ) : null}
    </aside>
  )
}

export default function OnlineGate() {
  const online = useOnlineLobby()
  const { reportLobbyActivity } = online
  const [password, setPassword] = useState('')
  const [nicknameError, setNicknameError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/version', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Version request failed: ${response.status}`)
        return response.json() as Promise<{ version?: string }>
      })
      .then((result) => setServerVersion(result.version ?? null))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setServerVersion(null)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const unlockAudio = () => unlockGameAudio()
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [])

  const hasDisconnectedSeat = Boolean(
    online.lobby?.seats.some((seat) => !seat.connected && seat.disconnectedExpiresAt),
  )
  const hasIdleSeat = Boolean(
    online.lobby?.seats.some((seat) => seat.connected && seat.idleExpiresAt),
  )

  useEffect(() => {
    if (!online.lobby?.countdownEndsAt && !hasDisconnectedSeat && !hasIdleSeat) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [hasDisconnectedSeat, hasIdleSeat, online.lobby?.countdownEndsAt])

  useEffect(() => {
    if (online.lobby?.status !== 'lobby' || online.session?.seat === null) return
    const reportActivity = () => reportLobbyActivity()
    const reportVisibleActivity = () => {
      if (document.visibilityState === 'visible') reportActivity()
    }
    window.addEventListener('pointerdown', reportActivity)
    window.addEventListener('keydown', reportActivity)
    document.addEventListener('visibilitychange', reportVisibleActivity)
    return () => {
      window.removeEventListener('pointerdown', reportActivity)
      window.removeEventListener('keydown', reportActivity)
      document.removeEventListener('visibilitychange', reportVisibleActivity)
    }
  }, [online.lobby?.status, online.session?.seat, reportLobbyActivity])

  const players = useMemo(
    () => lobbyPlayers(online.lobby?.seats ?? []),
    [online.lobby?.seats],
  )
  const countdown = online.lobby?.countdownEndsAt
    ? now === 0 ? 3 : Math.max(0, Math.ceil((online.lobby.countdownEndsAt - now) / 1000))
    : null

  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    if (password.trim()) online.authenticate(password)
  }

  if (online.status === 'password') {
    return (
      <main className="online-screen">
        <form className="access-card" onSubmit={submitPassword}>
          <span className="access-kicker">Monopoly Online</span>
          <h1>Введите пароль</h1>
          <p>Пароль защищает игровую комнату от случайных посетителей и ботов.</p>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Пароль комнаты"
            autoComplete="current-password"
          />
          {online.error ? <span className="online-error">{online.error}</span> : null}
          <button type="submit">Войти</button>
        </form>
        <VersionStatus serverVersion={serverVersion} />
      </main>
    )
  }

  if (!online.lobby || !online.session) {
    return (
      <main className="online-screen">
        <section className="connection-card">
          <span className="connection-spinner" />
          <h1>{online.status === 'offline' ? 'Возвращаемся в игру…' : 'Подключаемся…'}</h1>
          <p>Сессия восстановится автоматически.</p>
        </section>
        <VersionStatus serverVersion={serverVersion} />
      </main>
    )
  }

  if (online.lobby.status === 'playing') {
    return (
      <div className="online-game">
        <span className={`online-connection ${online.status === 'online' ? 'connected' : ''}`}>
          {online.status === 'online' ? 'Онлайн' : 'Переподключение…'}
        </span>
        <App
          key={online.lobby.gameId ?? 'online-game'}
          initialGamePlayers={players}
          localPlayerId={online.session.playerId}
          onlineState={
            online.gameState && online.gameState.gameId === online.lobby.gameId
              ? { revision: online.gameState.revision, state: online.gameState.state as OnlineGameState }
              : null
          }
          publishOnlineState={online.publishGameState}
          beginOnlineTurnAction={online.beginTurnAction}
          turnDeadline={online.turnDeadline}
          turnTimeoutSignal={online.turnTimeout}
          onReturnToLobby={online.returnToLobby}
          sendOnlineChat={online.sendChatMessage}
          disconnectedPlayerIds={online.lobby.seats.filter((seat) => seat.playerId && !seat.connected).map((seat) => seat.playerId as string)}
          onlineGameEvent={online.gameEvent}
          acknowledgeOnlineGameEvent={online.acknowledgeGameEvent}
          sendOnlineGameEvent={online.sendGameEvent}
        />
      </div>
    )
  }

  const ownSeat = online.session.seat
  const isReady = Boolean(online.session.ready)
  const ownLobbySeat = ownSeat === null ? null : online.lobby.seats[ownSeat] ?? null
  const ownIdleSeconds = ownLobbySeat?.idleExpiresAt
    ? Math.max(0, Math.ceil((ownLobbySeat.idleExpiresAt - now) / 1000))
    : null
  const commitNickname = (draft: string) => {
    const nickname = draft.trim().replace(/\s+/g, ' ')
    if (nickname.length < 1) {
      setNicknameError('Ник не может быть пустым')
      return false
    }
    setNicknameError('')
    if (nickname !== online.session?.nickname) online.setNickname(nickname)
    return true
  }

  const formatDisconnectTime = (expiresAt: number) => {
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
    const minutes = Math.floor(seconds / 60)
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  return (
    <main className="online-screen lobby-screen">
      <section className="lobby-card">
        {online.status !== 'online' ? <span className="lobby-connection-warning">Переподключение…</span> : null}
        <header className="lobby-header">
          <div>
            <span className="access-kicker">Общая комната</span>
            <h1>Игровое лобби</h1>
          </div>
          <span className="lobby-capacity">{players.length}/5 игроков</span>
        </header>

        <div className="lobby-seats">
          {online.lobby.seats.map((seat) => {
            const isOwn = seat.seat === ownSeat
            return (
              <article className={`lobby-seat ${seat.nickname ? 'occupied' : ''} ${isOwn ? 'own' : ''}`} key={seat.seat}>
                <span className="seat-number">{seat.seat + 1}</span>
                {seat.nickname ? (
                  <>
                    <span className="seat-avatar" style={{ '--seat-color': playerColors[seat.seat] } as CSSProperties}>
                      {seat.nickname.charAt(0).toLocaleUpperCase('ru-RU')}
                    </span>
                    <div className="seat-info">
                      <strong>{seat.nickname}</strong>
                      <span className={seat.connected && (!seat.idleExpiresAt || seat.idleExpiresAt - now > 60000) ? 'connected' : 'disconnected'}>
                        {seat.connected
                          ? seat.idleExpiresAt && seat.idleExpiresAt - now <= 60000
                            ? `Неактивен: ${formatDisconnectTime(seat.idleExpiresAt)}`
                            : seat.ready ? 'Готов' : 'В лобби'
                          : seat.disconnectedExpiresAt
                            ? `Освободится через ${formatDisconnectTime(seat.disconnectedExpiresAt)}`
                            : 'Переподключается'}
                      </span>
                    </div>
                    {isOwn ? <span className="your-seat">Вы</span> : null}
                  </>
                ) : (
                  <button type="button" onClick={() => online.claimSeat(seat.seat)}>Занять место</button>
                )}
              </article>
            )
          })}
        </div>

        {ownIdleSeconds !== null && ownIdleSeconds <= 60 ? (
          <section className="lobby-idle-warning" role="alert">
            <div>
              <strong>Вы давно неактивны</strong>
              <span>Место освободится через {formatDisconnectTime(ownLobbySeat?.idleExpiresAt ?? now)}</span>
            </div>
            <button type="button" onClick={reportLobbyActivity}>Я здесь</button>
          </section>
        ) : null}

        {ownSeat !== null ? (
          <section className="lobby-controls">
            <label>
              Ваш ник
              <input
                key={online.session.nickname}
                defaultValue={online.session.nickname}
                maxLength={20}
                onChange={() => setNicknameError('')}
                onBlur={(event) => commitNickname(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                  if (event.key === 'Escape') {
                    event.currentTarget.value = online.session?.nickname ?? ''
                    setNicknameError('')
                    event.currentTarget.blur()
                  }
                }}
              />
              {nicknameError ? <span className="nickname-error">{nicknameError}</span> : null}
            </label>
            <div className="lobby-actions">
              <button type="button" className="leave-seat-button" onClick={online.leaveSeat}>Освободить место</button>
              <button type="button" className={isReady ? 'ready-button active' : 'ready-button'} onClick={() => online.setReady(!isReady)}>
                {isReady ? 'Готов ✓' : 'Я готов'}
              </button>
            </div>
          </section>
        ) : (
          <p className="choose-seat-message">Выберите свободное место, чтобы изменить ник и подтвердить готовность.</p>
        )}

        {countdown !== null ? (
          <div className="lobby-countdown">
            <span>Все готовы</span>
            <strong>{countdown || 1}</strong>
            <small>Игра запускается…</small>
          </div>
        ) : (
          <footer className="lobby-footer">Игра начнётся, когда все занявшие место игроки нажмут «Я готов».</footer>
        )}
      </section>
      <VersionStatus serverVersion={serverVersion} />
    </main>
  )
}
