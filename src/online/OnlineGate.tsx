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

const formatCountdown = (expiresAt: number, now: number) => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

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
  const [roomMode, setRoomMode] = useState<'create' | 'join'>(() => online.inviteRoomCode ? 'join' : 'create')
  const [roomName, setRoomName] = useState('Моя комната')
  const [roomVisibility, setRoomVisibility] = useState<'public' | 'private'>('private')
  const [roomPassword, setRoomPassword] = useState('')
  const [roomCode, setRoomCode] = useState(online.inviteRoomCode)
  const [copiedInvite, setCopiedInvite] = useState(false)
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

  const submitRoom = (event: FormEvent) => {
    event.preventDefault()
    if (roomMode === 'create') {
      online.createRoom({
        name: roomName,
        visibility: roomVisibility,
        password: roomVisibility === 'private' ? roomPassword : '',
      })
      return
    }
    if (roomCode.trim()) online.joinRoom(roomCode, roomPassword)
  }

  if (online.status === 'replaced') {
    return (
      <main className="online-screen">
        <section className="connection-card">
          <span className="access-kicker">Сессия перенесена</span>
          <h1>Игра открыта в другой вкладке</h1>
          <p>Управление игроком передано последней открытой вкладке.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Вернуть управление сюда
          </button>
        </section>
        <VersionStatus serverVersion={serverVersion} />
      </main>
    )
  }

  if (online.roomHome) {
    return (
      <main className="online-screen room-home-screen">
        <section className="room-home-card room-browser">
          <header className="room-home-header">
            <span className="access-kicker">Monopoly Online</span>
          </header>

          <div className="room-browser-layout">
            <aside className="room-create-panel">
              <div className="room-mode-tabs" role="tablist" aria-label="Действие с комнатой">
                <button
                  type="button"
                  className={roomMode === 'create' ? 'active' : ''}
                  onClick={() => setRoomMode('create')}
                >
                  Создать
                </button>
                <button
                  type="button"
                  className={roomMode === 'join' ? 'active' : ''}
                  onClick={() => setRoomMode('join')}
                >
                  По коду
                </button>
              </div>

              <form className="room-form" onSubmit={submitRoom}>
                {roomMode === 'create' ? (
                  <>
                    <label>
                      Название комнаты
                      <input
                        autoFocus
                        value={roomName}
                        maxLength={40}
                        onChange={(event) => setRoomName(event.target.value)}
                        placeholder="Например, Вечерняя партия"
                      />
                    </label>
                    <fieldset className="room-visibility">
                      <legend>Доступ</legend>
                      <label>
                        <input
                          type="radio"
                          checked={roomVisibility === 'private'}
                          onChange={() => setRoomVisibility('private')}
                        />
                        <span><strong>Закрытая</strong><small>Код и пароль</small></span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          checked={roomVisibility === 'public'}
                          onChange={() => setRoomVisibility('public')}
                        />
                        <span><strong>Публичная</strong><small>Видна всем</small></span>
                      </label>
                    </fieldset>
                  </>
                ) : (
                  <label>
                    Код комнаты
                    <input
                      autoFocus
                      className="room-code-input"
                      value={roomCode}
                      maxLength={6}
                      onChange={(event) => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      placeholder="ABC234"
                      autoComplete="off"
                    />
                  </label>
                )}

                {(roomMode === 'join' || roomVisibility === 'private') ? (
                  <label>
                    Пароль {roomMode === 'join' ? <small>если установлен</small> : null}
                    <input
                      type="password"
                      required={roomMode === 'create' && roomVisibility === 'private'}
                      value={roomPassword}
                      onChange={(event) => setRoomPassword(event.target.value)}
                      placeholder={roomMode === 'join' ? 'Можно оставить пустым' : 'Придумайте пароль'}
                      autoComplete="off"
                    />
                  </label>
                ) : null}

                {online.error ? <span className="online-error" role="alert">{online.error}</span> : null}
                <button type="submit" disabled={roomMode === 'join' && roomCode.length !== 6}>
                  {roomMode === 'create' ? 'Создать комнату' : 'Подключиться'}
                </button>
              </form>
            </aside>

            <section className="room-directory">
              <header>
                <div>
                  <span className="access-kicker">Список серверов</span>
                  <h2>Открытые комнаты</h2>
                </div>
                <span className="room-count">{online.rooms.length}</span>
              </header>

              {online.rooms.length > 0 ? (
                <div className="room-list">
                  {online.rooms.map((room) => {
                    const unavailable = room.status === 'playing' || room.playerCount >= room.capacity
                    return (
                      <article className="room-list-item" key={room.id}>
                        <div className="room-list-main">
                          <span className={`room-status-dot ${room.status}`} aria-hidden="true" />
                          <div>
                            <strong>{room.name}</strong>
                            <small>Код {room.code}</small>
                          </div>
                        </div>
                        <span className="room-player-count">{room.playerCount}/{room.capacity}</span>
                        <button
                          type="button"
                          disabled={unavailable}
                          onClick={() => online.joinRoom(room.code, '')}
                        >
                          {room.status === 'playing' ? 'Игра идёт' : room.playerCount >= room.capacity ? 'Заполнена' : 'Войти'}
                        </button>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="room-list-empty">
                  <span>🎲</span>
                  <strong>Открытых комнат пока нет</strong>
                  <p>Создайте публичную комнату — она сразу появится здесь у остальных игроков.</p>
                </div>
              )}
            </section>
          </div>
        </section>
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
    const reconnectingSeats = online.lobby.seats.filter((seat) =>
      seat.nickname && !seat.connected && seat.disconnectedExpiresAt,
    )

    return (
      <div className="online-game">
        <span className={`online-connection ${online.status === 'online' ? 'connected' : ''}`}>
          {online.status === 'online' ? 'Онлайн' : 'Переподключение…'}
        </span>
        {reconnectingSeats.length > 0 ? (
          <aside className="game-reconnect-notices" aria-live="polite">
            {reconnectingSeats.map((seat) => (
              <div className="game-reconnect-notice" key={seat.playerId ?? seat.seat}>
                <span className="connection-spinner" aria-hidden="true" />
                <div>
                  <strong>{seat.nickname} переподключается</strong>
                  <small>
                    Ожидание: {formatCountdown(seat.disconnectedExpiresAt ?? now, now)}
                  </small>
                </div>
              </div>
            ))}
          </aside>
        ) : null}
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
  const occupiedLobbySeats = online.lobby.seats.filter((seat) => seat.playerId)
  const canLeaderStart = Boolean(
    online.session.isLeader &&
    occupiedLobbySeats.length >= 2 &&
    occupiedLobbySeats.every((seat) => seat.connected && seat.ready),
  )
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
  const inviteUrl = online.lobby.code
    ? (() => {
        const url = new URL(window.location.href)
        url.searchParams.set('room', online.lobby?.code ?? '')
        url.hash = ''
        return url.toString()
      })()
    : ''
  const copyInvite = async () => {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopiedInvite(true)
    window.setTimeout(() => setCopiedInvite(false), 1600)
  }

  return (
    <main className="online-screen lobby-screen">
      <section className="lobby-card">
        {online.status !== 'online' ? <span className="lobby-connection-warning">Переподключение…</span> : null}
        <header className="lobby-header">
          <div>
            <span className="access-kicker">{online.lobby.code ? `Комната ${online.lobby.code}` : 'Общая комната'}</span>
            <h1>{online.lobby.name ?? 'Игровое лобби'}</h1>
          </div>
          <div className="lobby-header-actions">
            {online.lobby.code ? (
              <>
                <button type="button" className="leave-room-button" onClick={online.leaveRoom}>
                  Выйти
                </button>
                <button type="button" className="copy-invite-button" onClick={copyInvite}>
                  {copiedInvite ? 'Ссылка скопирована' : 'Скопировать приглашение'}
                </button>
              </>
            ) : null}
            <span className="lobby-capacity">{players.length}/5 игроков</span>
          </div>
        </header>

        <div className="lobby-seats">
          {online.lobby.seats.map((seat) => {
            const isOwn = seat.seat === ownSeat
            const isLeader = Boolean(seat.playerId && seat.playerId === online.lobby?.leaderPlayerId)
            return (
              <article className={`lobby-seat ${seat.nickname ? 'occupied' : ''} ${isOwn ? 'own' : ''} ${isLeader ? 'leader' : ''}`} key={seat.seat}>
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
                            ? `Неактивен: ${formatCountdown(seat.idleExpiresAt, now)}`
                            : seat.ready ? 'Готов' : 'В лобби'
                          : seat.disconnectedExpiresAt
                            ? `Освободится через ${formatCountdown(seat.disconnectedExpiresAt, now)}`
                            : 'Переподключается'}
                      </span>
                    </div>
                    {isLeader ? <span className="leader-seat">Лидер</span> : null}
                    {isOwn ? <span className={isLeader ? 'your-seat with-leader' : 'your-seat'}>Вы</span> : null}
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
              <span>Место освободится через {formatCountdown(ownLobbySeat?.idleExpiresAt ?? now, now)}</span>
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
              {!online.lobby.code ? (
                <button type="button" className="leave-seat-button" onClick={online.leaveSeat}>Освободить место</button>
              ) : null}
              <button type="button" className={isReady ? 'ready-button active' : 'ready-button'} onClick={() => online.setReady(!isReady)}>
                {isReady ? 'Готов ✓' : 'Я готов'}
              </button>
              {online.session.isLeader ? (
                <button
                  type="button"
                  className="start-game-button"
                  disabled={!canLeaderStart}
                  onClick={online.startGame}
                >
                  Начать игру
                </button>
              ) : null}
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
          <footer className="lobby-footer">
            {online.lobby.code
              ? online.session.isLeader
                ? 'Вы лидер комнаты. После готовности всех игроков вы сможете начать игру.'
                : 'После готовности всех игроков лидер комнаты сможет начать игру.'
              : 'Игра начнётся, когда все занявшие место игроки нажмут «Я готов».'}
          </footer>
        )}
      </section>
      <VersionStatus serverVersion={serverVersion} />
    </main>
  )
}
