import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import App, { type OnlineGameState } from '../App'
import type { Player } from '../types'
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

export default function OnlineGate() {
  const online = useOnlineLobby()
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!online.lobby?.countdownEndsAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [online.lobby?.countdownEndsAt])

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
          turnDeadline={online.turnDeadline}
          turnTimeoutSignal={online.turnTimeout}
          onReturnToLobby={online.returnToLobby}
          sendOnlineChat={online.sendChatMessage}
          disconnectedPlayerIds={online.lobby.seats.filter((seat) => seat.playerId && !seat.connected).map((seat) => seat.playerId as string)}
          onlineGameEvent={online.gameEvent}
          sendOnlineGameEvent={online.sendGameEvent}
        />
      </div>
    )
  }

  const ownSeat = online.session.seat
  const isReady = Boolean(online.session.ready)
  const displayedNickname = nickname || online.session.nickname

  return (
    <main className="online-screen lobby-screen">
      <section className="lobby-card">
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
                      <span className={seat.connected ? 'connected' : 'disconnected'}>
                        {seat.connected ? seat.ready ? 'Готов' : 'В лобби' : 'Переподключается'}
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

        {ownSeat !== null ? (
          <section className="lobby-controls">
            <label>
              Ваш ник
              <input
                value={displayedNickname}
                maxLength={20}
                onChange={(event) => setNickname(event.target.value)}
                onBlur={() => online.setNickname(displayedNickname)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    online.setNickname(displayedNickname)
                    event.currentTarget.blur()
                  }
                }}
              />
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
    </main>
  )
}
