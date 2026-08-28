import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket, WebSocketServer } from 'ws'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const dataDirectory = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(rootDirectory, 'data')
const distDirectory = join(rootDirectory, 'dist')
mkdirSync(dataDirectory, { recursive: true })

const database = new DatabaseSync(join(dataDirectory, 'monopoly.sqlite'))
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'lobby',
    countdown_ends_at INTEGER,
    game_id TEXT
  );
  INSERT OR IGNORE INTO room (id, status) VALUES (1, 'lobby');

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    seat INTEGER UNIQUE,
    ready INTEGER NOT NULL DEFAULT 0,
    connected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    state_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    turn_key TEXT,
    turn_deadline INTEGER
  );
`)
try { database.exec('ALTER TABLE games ADD COLUMN turn_key TEXT') } catch {}
try { database.exec('ALTER TABLE games ADD COLUMN turn_deadline INTEGER') } catch {}
database.prepare('UPDATE sessions SET connected = 0').run()

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const configuredPassword = process.env.GAME_PASSWORD ?? 'monopoly'
const debugOnline = process.env.DEBUG_ONLINE === '1'
const passwordDigest = createHash('sha256').update(configuredPassword).digest()
const clients = new Map()
let countdownTimer = null
const timeoutControllers = new Map()
const turnDuration = Math.max(5, Number(process.env.TURN_SECONDS ?? 70)) * 1000
const tradeDecisionDuration = Math.max(5, Number(process.env.TRADE_SECONDS ?? 35)) * 1000

if (!process.env.GAME_PASSWORD) {
  console.warn('GAME_PASSWORD не задан. Для локальной разработки используется пароль: monopoly')
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

const send = (socket, message) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

const publicPlayerId = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16)
const trace = (event, details = {}) => {
  if (debugOnline) console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }))
}

const roomRow = () => database.prepare('SELECT * FROM room WHERE id = 1').get()
const sessionRows = () => database.prepare(`
  SELECT token, nickname, seat, ready, connected, last_seen
  FROM sessions
  WHERE seat IS NOT NULL
  ORDER BY seat
`).all()

const lobbyState = () => {
  const room = roomRow()
  const occupied = new Map(sessionRows().map((session) => [session.seat, session]))
  return {
    status: room.status,
    gameId: room.game_id ?? null,
    countdownEndsAt: room.countdown_ends_at ?? null,
    seats: Array.from({ length: 5 }, (_, seat) => {
      const session = occupied.get(seat)
      return session
        ? {
            seat,
            playerId: publicPlayerId(session.token),
            nickname: session.nickname,
            ready: Boolean(session.ready),
            connected: Boolean(session.connected),
          }
        : { seat, nickname: null, ready: false, connected: false }
    }),
  }
}

const broadcastLobby = () => {
  const lobby = lobbyState()
  for (const [socket, token] of clients) {
    const session = database.prepare('SELECT nickname, seat, ready FROM sessions WHERE token = ?').get(token)
    send(socket, { type: 'lobby', lobby, session: session ? { ...session, playerId: publicPlayerId(token) } : null })
  }
}

const sendStoredGameState = (socket, gameId) => {
  const game = database.prepare('SELECT state_json, updated_at, turn_deadline FROM games WHERE id = ?').get(gameId)
  if (!game?.state_json) return
  send(socket, {
    type: 'game_state',
    gameId,
    revision: game.updated_at,
    turnDeadline: game.turn_deadline,
    state: JSON.parse(game.state_json),
  })
}

const broadcastGameState = (gameId, state, revision, turnDeadline, senderId = null) => {
  for (const socket of clients.keys()) {
    send(socket, { type: 'game_state', gameId, revision, turnDeadline, senderId, state })
  }
}

const getTurnActorId = (state) => {
  if (state?.tradeDraft?.stage === 'review') return state.tradeDraft.targetPlayerId
  if (state?.auction?.activeBidderId) return state.auction.activeBidderId
  if (state?.pendingPayment?.payerId) return state.pendingPayment.payerId
  if (state?.casino?.playerId) return state.casino.playerId
  return state?.players?.[state.activePlayerIndex]?.id ?? null
}

const getTurnKey = (state) => JSON.stringify({
  turn: state?.turnSequence ?? 0,
  actor: getTurnActorId(state),
  phase: state?.pendingPayment ? 'payment'
    : state?.pendingTileId !== null && state?.pendingTileId !== undefined ? 'purchase'
      : state?.auction ? 'auction'
        : state?.casino ? 'casino'
          : state?.tradeDraft ? `trade:${state.tradeDraft.stage}`
            : state?.jailedPlayerIds?.includes(getTurnActorId(state)) ? 'jail'
              : 'roll',
})

const cancelCountdown = () => {
  if (countdownTimer) clearTimeout(countdownTimer)
  countdownTimer = null
  database.prepare('UPDATE room SET countdown_ends_at = NULL WHERE id = 1').run()
}

const beginGame = () => {
  const participants = sessionRows()
  if (participants.length < 2 || participants.some((player) => !player.ready)) {
    cancelCountdown()
    broadcastLobby()
    return
  }

  const now = Date.now()
  const gameId = randomUUID()
  database.prepare('INSERT INTO games (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(gameId, 'playing', now, now)
  database.prepare(`
    UPDATE room SET status = 'playing', countdown_ends_at = NULL, game_id = ? WHERE id = 1
  `).run(gameId)
  database.prepare('UPDATE sessions SET ready = 0 WHERE seat IS NOT NULL').run()
  countdownTimer = null
  broadcastLobby()
}

const reconcileCountdown = () => {
  const room = roomRow()
  if (room.status !== 'lobby') return
  const participants = sessionRows()
  const canStart = participants.length >= 2 && participants.every((player) => player.ready)

  if (!canStart) {
    if (room.countdown_ends_at) cancelCountdown()
    broadcastLobby()
    return
  }

  if (room.countdown_ends_at) return
  const countdownEndsAt = Date.now() + 3000
  database.prepare('UPDATE room SET countdown_ends_at = ? WHERE id = 1').run(countdownEndsAt)
  countdownTimer = setTimeout(beginGame, 3000)
  broadcastLobby()
}

const verifyPassword = (value) => {
  const candidate = createHash('sha256').update(String(value ?? '')).digest()
  return candidate.length === passwordDigest.length && timingSafeEqual(candidate, passwordDigest)
}

const authenticate = (socket, payload) => {
  const requestedToken = typeof payload.token === 'string' ? payload.token : ''
  const existing = requestedToken
    ? database.prepare('SELECT token FROM sessions WHERE token = ?').get(requestedToken)
    : null
  if (!existing && !verifyPassword(payload.password)) {
    send(socket, { type: 'auth_error', message: 'Неверный пароль' })
    return false
  }
  const token = existing ? requestedToken : randomUUID()
  const now = Date.now()

  if (existing) {
    database.prepare('UPDATE sessions SET connected = 1, last_seen = ? WHERE token = ?').run(now, token)
  } else {
    database.prepare(`
      INSERT INTO sessions (token, nickname, created_at, last_seen, connected)
      VALUES (?, ?, ?, ?, 1)
    `).run(token, `Игрок ${sessionRows().length + 1}`, now, now)
  }

  clients.set(socket, token)
  send(socket, { type: 'auth_ok', token })
  broadcastLobby()
  const room = roomRow()
  if (room.status === 'playing' && room.game_id) sendStoredGameState(socket, room.game_id)
  return true
}

const handleLobbyMessage = (socket, token, message) => {
  const room = roomRow()
  const session = database.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!session) return

  if (message.type === 'game_event' && room.status === 'playing' && room.game_id) {
    const game = database.prepare('SELECT state_json FROM games WHERE id = ?').get(room.game_id)
    const state = game?.state_json ? JSON.parse(game.state_json) : null
    const senderId = publicPlayerId(token)
    if (!state || getTurnActorId(state) !== senderId) {
      trace('game_event_rejected', {
        gameId: room.game_id,
        senderId,
        expectedActorId: getTurnActorId(state),
        reason: state ? 'not_actor' : 'no_state',
      })
      return
    }
    const event = message.event
    const validMovement = event?.kind === 'movement'
      && event.playerId === senderId
      && Number.isInteger(event.startPosition) && event.startPosition >= 0 && event.startPosition < 40
      && Number.isInteger(event.steps) && event.steps >= 1 && event.steps <= 40
      && (event.direction === 1 || event.direction === -1)
    const validDirectMovement = event?.kind === 'direct-movement'
      && event.playerId === senderId
      && Number.isInteger(event.startPosition) && event.startPosition >= 0 && event.startPosition < 40
      && Number.isInteger(event.destinationPosition) && event.destinationPosition >= 0 && event.destinationPosition < 40
      && Number.isFinite(event.speedMultiplier) && event.speedMultiplier >= 0.5 && event.speedMultiplier <= 3
    if (!validMovement && !validDirectMovement) {
      trace('game_event_rejected', { gameId: room.game_id, senderId, reason: 'invalid_payload' })
      return
    }
    const payload = { type: 'game_event', gameId: room.game_id, eventId: randomUUID(), senderId, event }
    for (const client of clients.keys()) send(client, payload)
    trace('game_event', { gameId: room.game_id, senderId, kind: event.kind })
    return
  }

  if (message.type === 'chat_message' && room.status === 'playing' && room.game_id) {
    const text = String(message.text ?? '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 256)
    if (!text) return
    const game = database.prepare('SELECT state_json, updated_at, turn_deadline FROM games WHERE id = ?').get(room.game_id)
    if (!game?.state_json) return
    const state = JSON.parse(game.state_json)
    const senderId = publicPlayerId(token)
    const player = state.players?.find((item) => item.id === senderId)
    if (!player || state.eliminatedPlayerIds?.includes(senderId)) return
    state.logs = [...(state.logs ?? []), {
      id: randomUUID(),
      playerId: senderId,
      text: `${player.name}: ${text}`,
      kind: 'chat',
      time: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date()),
    }]
    const revision = Math.max(Date.now(), Number(game.updated_at ?? 0) + 1)
    database.prepare('UPDATE games SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), revision, room.game_id)
    broadcastGameState(room.game_id, state, revision, game.turn_deadline, 'server')
    return
  }

  if (message.type === 'game_snapshot' && room.status === 'playing' && room.game_id) {
    const state = message.state
    if (!state || typeof state !== 'object' || !Array.isArray(state.players)) return
    const storedGame = database.prepare('SELECT state_json, updated_at, turn_key, turn_deadline FROM games WHERE id = ?').get(room.game_id)
    const storedState = storedGame?.state_json ? JSON.parse(storedGame.state_json) : null
    const previousActorId = getTurnActorId(storedState)
    const senderId = publicPlayerId(token)
    const initialActivePlayer = state.players?.[state.activePlayerIndex]
    const mayInitialize = !storedState && initialActivePlayer?.id === senderId
    const mayUpdate = previousActorId === senderId
    const previousTradeTarget = storedState?.tradeDraft?.stage === 'review' ? storedState.tradeDraft.targetPlayerId : null
    const mayAnswerTrade = previousTradeTarget === senderId
    const mayHandleTimeout = timeoutControllers.get(room.game_id) === token
    if (!mayInitialize && !mayUpdate && !mayAnswerTrade && !mayHandleTimeout) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        expectedActorId: previousActorId,
      })
      return
    }

    const revision = Math.max(Date.now(), Number(storedGame?.updated_at ?? 0) + 1)
    const turnKey = getTurnKey(state)
    const decisionDuration = state.tradeDraft?.stage === 'review' ? tradeDecisionDuration : turnDuration
    const turnDeadline = turnKey === storedGame?.turn_key && storedGame?.turn_deadline
      ? storedGame.turn_deadline
      : revision + decisionDuration
    timeoutControllers.delete(room.game_id)
    database.prepare('UPDATE games SET state_json = ?, updated_at = ?, turn_key = ?, turn_deadline = ? WHERE id = ?')
      .run(JSON.stringify(state), revision, turnKey, turnDeadline, room.game_id)
    broadcastGameState(room.game_id, state, revision, turnDeadline, senderId)
    trace('snapshot', { gameId: room.game_id, revision, senderId, turnKey })
    return
  }

  if (message.type === 'return_to_lobby' && room.status === 'playing' && room.game_id) {
    const game = database.prepare('SELECT state_json FROM games WHERE id = ?').get(room.game_id)
    const state = game?.state_json ? JSON.parse(game.state_json) : null
    if (!state?.winnerId) return
    database.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', room.game_id)
    database.prepare("UPDATE room SET status = 'lobby', game_id = NULL, countdown_ends_at = NULL WHERE id = 1").run()
    database.prepare('UPDATE sessions SET ready = 0 WHERE seat IS NOT NULL').run()
    timeoutControllers.delete(room.game_id)
    broadcastLobby()
    return
  }

  if (message.type === 'claim_seat' && room.status === 'lobby') {
    const seat = Number(message.seat)
    if (!Number.isInteger(seat) || seat < 0 || seat > 4) return
    const occupant = database.prepare('SELECT token FROM sessions WHERE seat = ?').get(seat)
    if (occupant && occupant.token !== token) {
      send(socket, { type: 'action_error', message: 'Это место уже занято' })
      return
    }
    database.prepare('UPDATE sessions SET seat = NULL, ready = 0 WHERE token = ?').run(token)
    database.prepare('UPDATE sessions SET seat = ?, ready = 0, last_seen = ? WHERE token = ?')
      .run(seat, Date.now(), token)
  }

  if (message.type === 'leave_seat' && room.status === 'lobby') {
    database.prepare('UPDATE sessions SET seat = NULL, ready = 0, last_seen = ? WHERE token = ?')
      .run(Date.now(), token)
  }

  if (message.type === 'set_nickname') {
    const nickname = String(message.nickname ?? '').trim().replace(/\s+/g, ' ').slice(0, 20)
    if (nickname.length >= 2) {
      database.prepare('UPDATE sessions SET nickname = ?, last_seen = ? WHERE token = ?')
        .run(nickname, Date.now(), token)
    }
  }

  if (message.type === 'set_ready' && room.status === 'lobby' && session.seat !== null) {
    database.prepare('UPDATE sessions SET ready = ?, last_seen = ? WHERE token = ?')
      .run(message.ready ? 1 : 0, Date.now(), token)
  }

  reconcileCountdown()
  broadcastLobby()
}

const server = createServer(async (request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  if (request.url === '/api/entropy/fx') {
    try {
      const upstream = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', {
        signal: AbortSignal.timeout(1800),
      })
      if (!upstream.ok) throw new Error(`FX upstream: ${upstream.status}`)
      const body = await upstream.text()
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'FX source unavailable' }))
    }
    return
  }

  const requestPath = request.url === '/' ? '/index.html' : String(request.url).split('?')[0]
  const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = join(distDirectory, safePath)

  try {
    if (!statSync(filePath).isFile()) filePath = join(distDirectory, 'index.html')
  } catch {
    filePath = join(distDirectory, 'index.html')
  }

  try {
    const body = readFileSync(filePath)
    response.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Сначала выполните npm run build')
  }
})

const webSocketServer = new WebSocketServer({ server, path: '/ws' })
webSocketServer.on('connection', (socket) => {
  const authTimeout = setTimeout(() => socket.close(4001, 'Authentication timeout'), 10000)

  socket.on('message', (rawMessage) => {
    let message
    try {
      message = JSON.parse(String(rawMessage))
    } catch {
      return
    }

    const token = clients.get(socket)
    if (!token) {
      if (message.type === 'auth' && authenticate(socket, message)) clearTimeout(authTimeout)
      return
    }

    database.prepare('UPDATE sessions SET last_seen = ?, connected = 1 WHERE token = ?').run(Date.now(), token)
    handleLobbyMessage(socket, token, message)
  })

  socket.on('close', () => {
    clearTimeout(authTimeout)
    const token = clients.get(socket)
    clients.delete(socket)
    if (token && ![...clients.values()].includes(token)) {
      database.prepare('UPDATE sessions SET connected = 0, last_seen = ? WHERE token = ?').run(Date.now(), token)
      broadcastLobby()
    }
  })
})

setInterval(() => {
  if (roomRow().status !== 'lobby') return
  const staleBefore = Date.now() - 15 * 60 * 1000
  database.prepare(`
    UPDATE sessions SET seat = NULL, ready = 0
    WHERE connected = 0 AND seat IS NOT NULL AND last_seen < ?
  `).run(staleBefore)
  reconcileCountdown()
}, 60000).unref()

setInterval(() => {
  const room = roomRow()
  if (room.status !== 'playing' || !room.game_id || timeoutControllers.has(room.game_id)) return
  const game = database.prepare('SELECT state_json, turn_key, turn_deadline FROM games WHERE id = ?').get(room.game_id)
  if (!game?.state_json || !game.turn_deadline || game.turn_deadline > Date.now()) return

  const state = JSON.parse(game.state_json)
  const actorId = getTurnActorId(state)
  const connectedSessions = sessionRows().filter((session) => session.connected)
  const controller = connectedSessions.find((session) => publicPlayerId(session.token) === actorId)
    ?? connectedSessions[0]
  if (!controller) return

  const controllerSocket = [...clients.entries()].find(([, token]) => token === controller.token)?.[0]
  if (!controllerSocket) return
  timeoutControllers.set(room.game_id, controller.token)
  trace('turn_timeout', { gameId: room.game_id, actorId, controllerId: publicPlayerId(controller.token) })
  send(controllerSocket, {
    type: 'turn_timeout',
    gameId: room.game_id,
    turnKey: game.turn_key,
    actorId,
  })
}, 500).unref()

server.listen(port, host, () => {
  console.log(`Monopoly online server: http://${host}:${port}`)
})
