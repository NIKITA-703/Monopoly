import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket, WebSocketServer } from 'ws'
import { createAuditLog } from './audit-log.mjs'
import { createRoomStore, installRoomSchema } from './room-store.mjs'
import {
  validateAuctionTransition,
  validateCasinoTransition,
  validateGameState,
  validateInitialGameState,
  validateMoneyTransition,
  validatePendingPaymentTransition,
  validatePendingTileTransition,
  validatePropertyTransition,
  validatePurchaseTransition,
  validateTradeResolution,
} from './game-state-validation.mjs'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const dataDirectory = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(rootDirectory, 'data')
const distDirectory = join(rootDirectory, 'dist')
const appVersion = JSON.parse(readFileSync(join(rootDirectory, 'package.json'), 'utf8')).version
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

  CREATE TABLE IF NOT EXISTS landings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    player_color TEXT NOT NULL,
    tile_id INTEGER NOT NULL,
    tile_name TEXT NOT NULL,
    movement_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS landings_game_id_idx ON landings (game_id);
  CREATE INDEX IF NOT EXISTS landings_tile_id_idx ON landings (tile_id);

  CREATE TABLE IF NOT EXISTS processed_requests (
    session_token TEXT NOT NULL,
    request_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_token, request_id)
  );
  CREATE INDEX IF NOT EXISTS processed_requests_created_at_idx ON processed_requests (created_at);
`)
try { database.exec('ALTER TABLE games ADD COLUMN turn_key TEXT') } catch {}
try { database.exec('ALTER TABLE games ADD COLUMN turn_deadline INTEGER') } catch {}
try { database.exec("ALTER TABLE landings ADD COLUMN tile_name TEXT NOT NULL DEFAULT ''") } catch {}
installRoomSchema(database)
const roomStore = createRoomStore(database)
database.prepare('UPDATE sessions SET connected = 0').run()

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'
const configuredPassword = process.env.GAME_PASSWORD ?? 'monopoly'
const legacySingleRoom = process.env.LEGACY_SINGLE_ROOM === '1'
const sessionSecret = process.env.SESSION_SECRET ?? configuredPassword
const debugOnline = process.env.DEBUG_ONLINE === '1'
const passwordDigest = createHash('sha256').update(configuredPassword).digest()
const accessCookieName = 'monopoly_access'
const accessCookieValue = createHmac('sha256', sessionSecret).update('monopoly-access-v1').digest('hex')
const clients = new Map()
const clientPresence = new Map()
let countdownTimer = null
const timeoutControllers = new Map()
const gameReturnTimers = new Map()
const turnActionControllers = new Map()
const movementAuthorizations = new Map()
const rollAuthorizations = new Map()
const idempotentMessageTypes = new Set([
  'claim_seat',
  'leave_seat',
  'set_nickname',
  'set_ready',
  'create_room',
  'join_room',
  'leave_room',
  'turn_action_started',
  'game_event',
  'chat_message',
  'game_snapshot',
  'return_to_lobby',
])
const turnDuration = Math.max(5, Number(process.env.TURN_SECONDS ?? 70)) * 1000
const tradeDecisionDuration = Math.max(5, Number(process.env.TRADE_SECONDS ?? 35)) * 1000
const auctionDecisionDuration = Math.max(1, Number(process.env.AUCTION_SECONDS ?? 40)) * 1000
const turnActionDuration = Math.max(10, Number(process.env.TURN_ACTION_SECONDS ?? 30)) * 1000
const lobbyDisconnectDuration = Math.max(1, Number(process.env.LOBBY_DISCONNECT_SECONDS ?? 600)) * 1000
const lobbyIdleDuration = Math.max(1, Number(process.env.LOBBY_IDLE_SECONDS ?? 900)) * 1000
const auditLog = createAuditLog({
  directory: dataDirectory,
  debug: debugOnline,
  maxBytes: Number(process.env.AUDIT_LOG_MAX_BYTES ?? 5 * 1024 * 1024),
  maxFiles: Number(process.env.AUDIT_LOG_FILES ?? 5),
  maxAgeDays: Number(process.env.AUDIT_LOG_MAX_AGE_DAYS ?? 14),
})

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

const claimRequest = (token, message) => {
  if (!idempotentMessageTypes.has(message.type)) return { accepted: true, requestId: null }
  if (message.requestId == null) return { accepted: true, requestId: null }
  if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(message.requestId)) {
    return { accepted: false, requestId: null, invalid: true }
  }
  const result = database.prepare(`
    INSERT OR IGNORE INTO processed_requests (session_token, request_id, message_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(token, message.requestId, message.type, Date.now())
  return { accepted: result.changes === 1, requestId: message.requestId, invalid: false }
}

const publicPlayerId = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16)
const tileNames = [
  'Старт', 'Balenciaga', 'Вопросик', 'Louis Vuitton', 'Налог', 'Tesla', 'Nike', 'Вопросик',
  'Adidas', 'Kari', 'Тюрьма', 'Steam', 'Netflix', 'Epic Games', 'Electronic Arts', 'Porsche',
  'Google', 'Вопросик', 'Microsoft', 'Amazon', 'Казино', 'ChatGPT', 'Налог', 'Claude', 'Grok',
  'Bentley', 'Fanvue', 'Fansly', 'Apple TV+', 'OnlyFans', 'Полиция', 'Instagram', 'Reddit',
  'Вопросик', 'TikTok', 'Rolls-Royce', 'Алмазик', 'NASA', 'Вопросик', 'SpaceX',
]
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
            disconnectedExpiresAt: session.connected ? null : session.last_seen + lobbyDisconnectDuration,
            idleExpiresAt: session.connected ? session.last_seen + lobbyIdleDuration : null,
          }
        : { seat, nickname: null, ready: false, connected: false, disconnectedExpiresAt: null, idleExpiresAt: null }
    }),
  }
}

const broadcastLobby = () => {
  if (!legacySingleRoom) return
  const lobby = lobbyState()
  for (const [socket, token] of clients) {
    if (roomStore.getMembership(token)) continue
    const session = database.prepare('SELECT nickname, seat, ready FROM sessions WHERE token = ?').get(token)
    send(socket, { type: 'lobby', lobby, session: session ? { ...session, playerId: publicPlayerId(token) } : null })
  }
}

const multiplayerLobbyState = (roomId) => {
  const room = roomStore.getRoom(roomId)
  if (!room) return null
  const members = roomStore.listMembers(roomId)
  const sessions = new Map(members.map((member) => {
    const session = database.prepare(`
      SELECT nickname, connected, last_seen FROM sessions WHERE token = ?
    `).get(member.session_token)
    return [member.session_token, session]
  }))
  const occupied = new Map(members.map((member) => [member.seat, member]))
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    visibility: room.visibility,
    status: room.status,
    gameId: room.game_id ?? null,
    leaderPlayerId: publicPlayerId(room.leader_token),
    countdownEndsAt: null,
    seats: Array.from({ length: 5 }, (_, seat) => {
      const member = occupied.get(seat)
      const session = member ? sessions.get(member.session_token) : null
      return member && session
        ? {
            seat,
            playerId: publicPlayerId(member.session_token),
            nickname: session.nickname,
            ready: Boolean(member.ready),
            connected: Boolean(session.connected),
            disconnectedExpiresAt: session.connected ? null : session.last_seen + lobbyDisconnectDuration,
            idleExpiresAt: session.connected ? member.last_active_at + lobbyIdleDuration : null,
          }
        : { seat, nickname: null, ready: false, connected: false, disconnectedExpiresAt: null, idleExpiresAt: null }
    }),
  }
}

const sendMultiplayerLobby = (socket, token, roomId) => {
  const lobby = multiplayerLobbyState(roomId)
  const member = roomStore.getMembership(token)
  const session = database.prepare('SELECT nickname FROM sessions WHERE token = ?').get(token)
  if (!lobby || !member || member.room_id !== roomId || !session) return
  send(socket, {
    type: 'lobby',
    lobby,
    session: {
      nickname: session.nickname,
      seat: member.seat,
      ready: member.ready,
      playerId: publicPlayerId(token),
      isLeader: lobby.leaderPlayerId === publicPlayerId(token),
    },
  })
}

const broadcastMultiplayerLobby = (roomId) => {
  for (const [socket, token] of clients) {
    if (roomStore.getMembership(token)?.room_id === roomId) sendMultiplayerLobby(socket, token, roomId)
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

const timeoutCountsAsMissedTurn = (state) => {
  const activePlayerId = state?.players?.[state.activePlayerIndex]?.id ?? null
  return Boolean(activePlayerId && !state?.auction && !state?.tradeDraft && getTurnActorId(state) === activePlayerId)
}

const summarizeGameState = (state) => {
  if (!state || !Array.isArray(state.players)) return null
  return {
    turnSequence: state.turnSequence ?? 0,
    phase: state.pendingPayment ? 'payment'
      : state.pendingTileId !== null && state.pendingTileId !== undefined ? 'purchase'
        : state.auction ? 'auction'
          : state.casino ? 'casino'
            : state.tradeDraft ? `trade:${state.tradeDraft.stage}`
              : 'roll',
    actorId: getTurnActorId(state),
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      money: player.money,
      position: player.position,
      eliminated: state.eliminatedPlayerIds?.includes(player.id) ?? false,
    })),
    owners: Object.keys(state.owners ?? {}).length,
    pendingTileId: state.pendingTileId ?? null,
    pendingPayment: state.pendingPayment
      ? {
          kind: state.pendingPayment.kind,
          payerId: state.pendingPayment.payerId,
          recipientId: state.pendingPayment.recipientId ?? null,
          amount: state.pendingPayment.amount,
        }
      : null,
    winnerId: state.winnerId ?? null,
  }
}

const trace = (action, details = {}) => {
  const storedGame = details.gameId
    ? database.prepare('SELECT state_json FROM games WHERE id = ?').get(details.gameId)
    : null
  const storedState = storedGame?.state_json ? JSON.parse(storedGame.state_json) : null
  const summary = summarizeGameState(storedState)
  return auditLog.write(action, {
    roomId: 1,
    playerId: details.playerId ?? details.senderId ?? details.actorId ?? null,
    turnSequence: details.turnSequence ?? summary?.turnSequence ?? null,
    phase: details.phase ?? summary?.phase ?? null,
    ...details,
  })
}

const recordLanding = (gameId, state, event) => {
  const player = state?.players?.find((item) => item.id === event.playerId)
  if (!player) return
  const tileId = event.kind === 'movement'
    ? (event.startPosition + event.steps * event.direction + 40 * 2) % 40
    : event.destinationPosition
  database.prepare(`
    INSERT INTO landings (game_id, player_id, player_name, player_color, tile_id, tile_name, movement_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gameId, player.id, player.name, player.color, tileId, tileNames[tileId] ?? `Поле ${tileId}`, event.kind, Date.now())
  trace('player_landing', {
    gameId,
    playerId: player.id,
    playerName: player.name,
    playerColor: player.color,
    tileId,
    tileName: tileNames[tileId] ?? `Поле ${tileId}`,
    movementKind: event.kind,
  })
}

const normalizeEliminatedState = (state) => {
  if (!state || !Array.isArray(state.players)) return state
  state.missedTurnCounts = state.missedTurnCounts ?? {}
  state.tradeRequestsThisTurn = Math.max(0, Math.trunc(Number(state.tradeRequestsThisTurn) || 0))
  const eliminatedIds = new Set(Array.isArray(state?.eliminatedPlayerIds) ? state.eliminatedPlayerIds : [])
  if (eliminatedIds.size === 0) return state

  state.players = state.players.map((player) =>
    eliminatedIds.has(player.id) ? { ...player, money: 0, lastDelta: 0 } : player)

  const eliminatedTileIds = Object.entries(state.owners ?? {})
    .filter(([, ownerId]) => eliminatedIds.has(ownerId))
    .map(([tileId]) => Number(tileId))
  const eliminatedTiles = new Set(eliminatedTileIds)
  state.owners = Object.fromEntries(
    Object.entries(state.owners ?? {}).filter(([, ownerId]) => !eliminatedIds.has(ownerId)),
  )
  state.propertyLevels = Object.fromEntries(
    Object.entries(state.propertyLevels ?? {}).filter(([tileId]) => !eliminatedTiles.has(Number(tileId))),
  )
  state.mortgagedPropertyIds = (state.mortgagedPropertyIds ?? []).filter((tileId) => !eliminatedTiles.has(tileId))
  state.mortgageExpiryTurns = Object.fromEntries(
    Object.entries(state.mortgageExpiryTurns ?? {}).filter(([tileId]) => !eliminatedTiles.has(Number(tileId))),
  )
  state.jailedPlayerIds = (state.jailedPlayerIds ?? []).filter((playerId) => !eliminatedIds.has(playerId))
  state.jailFailedAttempts = Object.fromEntries(
    Object.entries(state.jailFailedAttempts ?? {}).filter(([playerId]) => !eliminatedIds.has(playerId)),
  )
  state.playerEffects = Object.fromEntries(
    Object.entries(state.playerEffects ?? {}).filter(([playerId]) => !eliminatedIds.has(playerId)),
  )
  state.lapCounts = Object.fromEntries(
    Object.entries(state.lapCounts ?? {}).filter(([playerId]) => !eliminatedIds.has(playerId)),
  )
  state.eventPaymentQueue = (state.eventPaymentQueue ?? []).filter((payment) =>
    !eliminatedIds.has(payment.payerId) && (!payment.recipientId || !eliminatedIds.has(payment.recipientId)))
  if (
    state.pendingPayment &&
    (eliminatedIds.has(state.pendingPayment.payerId) ||
      (state.pendingPayment.recipientId && eliminatedIds.has(state.pendingPayment.recipientId)))
  ) {
    state.pendingPayment = null
  }
  return state
}

const settleBalancesForElimination = (previous, next, newlyEliminatedIds) => {
  if (!previous || newlyEliminatedIds.length === 0) return
  const eliminatedIds = new Set(newlyEliminatedIds)
  const balances = new Map(previous.players.map((player) => [player.id, player.money]))
  const payment = previous.pendingPayment
  if (payment && eliminatedIds.has(payment.payerId) && payment.recipientId && balances.has(payment.recipientId)) {
    const available = Math.min(balances.get(payment.payerId) ?? 0, payment.amount)
    balances.set(payment.recipientId, (balances.get(payment.recipientId) ?? 0) + available)
  }
  for (const playerId of eliminatedIds) balances.set(playerId, 0)
  next.players = next.players.map((player) => ({
    ...player,
    money: balances.get(player.id) ?? player.money,
    ...(eliminatedIds.has(player.id) ? { lastDelta: 0 } : {}),
  }))
}

const preservePendingServerRewards = (previous, next) => {
  if (!previous) return
  const pendingBookBonusKeys = new Set(previous.serverEconomy?.pendingBookBonusKeys ?? [])
  for (const player of previous.players) {
    const previousLap = previous.lapCounts?.[player.id] ?? 0
    const nextLap = next.lapCounts?.[player.id] ?? 0
    if (
      previous.playerEffects?.[player.id]?.bookChallenge &&
      !next.playerEffects?.[player.id]?.bookChallenge && nextLap > previousLap
    ) pendingBookBonusKeys.add(`start:${player.id}:${nextLap}`)
  }
  next.serverEconomy = {
    ...next.serverEconomy,
    pendingBookBonusKeys: [...pendingBookBonusKeys].slice(-50),
  }
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

const returnGameToLobby = (gameId, reason) => {
  const returnTimer = gameReturnTimers.get(gameId)
  if (returnTimer) clearTimeout(returnTimer)
  gameReturnTimers.delete(gameId)
  database.prepare('UPDATE games SET status = ? WHERE id = ?').run('finished', gameId)
  database.prepare("UPDATE room SET status = 'lobby', game_id = NULL, countdown_ends_at = NULL WHERE id = 1").run()
  database.prepare('UPDATE sessions SET ready = 0, last_seen = ? WHERE seat IS NOT NULL').run(Date.now())
  timeoutControllers.delete(gameId)
  turnActionControllers.delete(gameId)
  movementAuthorizations.delete(gameId)
  rollAuthorizations.delete(gameId)
  trace('game_returned_to_lobby', { gameId, reason })
  broadcastLobby()
}

const scheduleGameReturnToLobby = (gameId) => {
  if (gameReturnTimers.has(gameId)) return
  const returnTimer = setTimeout(() => {
    const currentRoom = roomRow()
    if (currentRoom.status === 'playing' && currentRoom.game_id === gameId) {
      returnGameToLobby(gameId, 'winner_detected')
    }
  }, 3000)
  returnTimer.unref()
  gameReturnTimers.set(gameId, returnTimer)
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
  trace('game_started', {
    gameId,
    playerIds: participants.map((participant) => publicPlayerId(participant.token)),
  })
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

const parseCookies = (header = '') => Object.fromEntries(
  String(header).split(';').flatMap((part) => {
    const separator = part.indexOf('=')
    if (separator < 0) return []
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]]
  }),
)

const hasAccessCookie = (request) => {
  const candidate = parseCookies(request.headers.cookie)[accessCookieName] ?? ''
  const candidateBuffer = Buffer.from(candidate)
  const expectedBuffer = Buffer.from(accessCookieValue)
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)
}

const readJsonBody = (request, maximumBytes = 4096) => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
    if (body.length > maximumBytes) reject(new Error('request_too_large'))
  })
  request.on('end', () => {
    try {
      resolve(JSON.parse(body || '{}'))
    } catch {
      reject(new Error('invalid_json'))
    }
  })
  request.on('error', reject)
})

const authenticate = (socket, payload) => {
  const requestedToken = typeof payload.token === 'string' ? payload.token : ''
  const existing = requestedToken
    ? database.prepare('SELECT token FROM sessions WHERE token = ?').get(requestedToken)
    : null
  if (!existing && !socket.hasAccess && !verifyPassword(payload.password)) {
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

  for (const [client, clientToken] of clients) {
    if (client !== socket && clientToken === token) client.close(4002, 'Session opened in another tab')
  }
  clients.set(socket, token)
  clientPresence.set(socket, { visible: false, updatedAt: now })
  send(socket, { type: 'auth_ok', token })
  const membership = roomStore.getMembership(token)
  if (membership) {
    broadcastMultiplayerLobby(membership.room_id)
    const multiplayerRoom = roomStore.getRoom(membership.room_id)
    if (multiplayerRoom?.status === 'playing' && multiplayerRoom.game_id) {
      sendStoredGameState(socket, multiplayerRoom.game_id)
    }
  } else {
    send(socket, { type: 'room_home' })
    if (legacySingleRoom) {
      broadcastLobby()
      const room = roomRow()
      if (room.status === 'playing' && room.game_id) sendStoredGameState(socket, room.game_id)
    }
  }
  return true
}

const roomActionMessages = {
  already_in_room: 'Сначала выйдите из текущей комнаты',
  invalid_room_password: 'Неверный пароль комнаты',
  invalid_session: 'Сессия игрока недействительна',
  invalid_visibility: 'Некорректный тип комнаты',
  room_already_playing: 'Игра в этой комнате уже началась',
  room_code_unavailable: 'Не удалось создать код комнаты. Попробуйте ещё раз',
  room_full: 'В комнате уже пять игроков',
  room_not_found: 'Комната с таким кодом не найдена',
  room_password_required: 'Для закрытой комнаты задайте пароль',
}

const handleRoomDirectoryMessage = (socket, token, message) => {
  if (!['create_room', 'join_room', 'leave_room'].includes(message.type)) return false
  try {
    if (message.type === 'leave_room') {
      const result = roomStore.leaveRoom(token)
      auditLog.write('room_left', {
        roomId: result.roomId,
        playerId: publicPlayerId(token),
        roomClosed: result.closed,
        leaderPlayerId: result.newLeaderToken ? publicPlayerId(result.newLeaderToken) : null,
      })
      send(socket, { type: 'room_home' })
      if (result.roomId && !result.closed) broadcastMultiplayerLobby(result.roomId)
      return true
    }
    const room = message.type === 'create_room'
      ? roomStore.createRoom({
          leaderToken: token,
          name: message.name,
          visibility: message.visibility,
          password: message.password,
        })
      : roomStore.findRoomByCode(message.code)
    const membership = message.type === 'create_room'
      ? roomStore.getMembership(token)
      : roomStore.joinRoom({ sessionToken: token, code: message.code, password: message.password })
    const roomId = membership?.room_id ?? room?.id
    if (!roomId) throw new Error('room_not_found')
    auditLog.write(message.type === 'create_room' ? 'room_created' : 'room_joined', {
      roomId,
      playerId: publicPlayerId(token),
    })
    broadcastMultiplayerLobby(roomId)
  } catch (error) {
    send(socket, {
      type: 'action_error',
      message: roomActionMessages[error?.message] ?? 'Не удалось выполнить действие с комнатой',
      code: error?.message ?? 'room_action_failed',
    })
  }
  return true
}

const handleLobbyMessage = (socket, token, message) => {
  if (handleRoomDirectoryMessage(socket, token, message)) return
  if (roomStore.getMembership(token)) return
  if (!legacySingleRoom) return
  const room = roomRow()
  const session = database.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!session) return

  if (message.type === 'client_presence') {
    clientPresence.set(socket, {
      visible: message.visible === true,
      updatedAt: Date.now(),
    })
    return
  }

  if (message.type === 'turn_action_started' && room.status === 'playing' && room.game_id) {
    const game = database.prepare('SELECT state_json, turn_key, turn_deadline FROM games WHERE id = ?').get(room.game_id)
    const state = game?.state_json ? JSON.parse(game.state_json) : null
    const senderId = publicPlayerId(token)
    const isRollPhase = state && !state.winnerId && !state.pendingPayment && state.pendingTileId == null &&
      !state.auction && !state.casino && !state.tradeDraft
    if (!isRollPhase || getTurnActorId(state) !== senderId || !game.turn_deadline || game.turn_deadline <= Date.now()) {
      trace('turn_action_rejected', { gameId: room.game_id, senderId, reason: 'expired_or_unavailable' })
      send(socket, { type: 'action_error', message: 'Время хода уже закончилось' })
      return
    }
    const existingAction = turnActionControllers.get(room.game_id)
    if (existingAction?.turnKey === game.turn_key) return
    const actionDeadline = Date.now() + turnActionDuration
    turnActionControllers.set(room.game_id, { turnKey: game.turn_key, playerId: senderId })
    timeoutControllers.delete(room.game_id)
    database.prepare('UPDATE games SET turn_deadline = ? WHERE id = ?').run(actionDeadline, room.game_id)
    for (const client of clients.keys()) {
      send(client, { type: 'turn_deadline', gameId: room.game_id, turnDeadline: actionDeadline })
    }
    trace('turn_action_started', { gameId: room.game_id, senderId, turnKey: game.turn_key })
    return
  }

  if (message.type === 'game_event' && room.status === 'playing' && room.game_id) {
    const game = database.prepare('SELECT state_json, turn_key FROM games WHERE id = ?').get(room.game_id)
    const state = game?.state_json ? JSON.parse(game.state_json) : null
    const senderId = publicPlayerId(token)
    const expectedActorId = getTurnActorId(state)
    const timeoutController = timeoutControllers.get(room.game_id)
    const mayHandleTimeout = Boolean(
      typeof message.timeoutId === 'string' &&
      timeoutController?.timeoutId === message.timeoutId &&
      timeoutController.turnKey === game?.turn_key &&
      timeoutController.claimedBy === senderId,
    )
    if (!state || (expectedActorId !== senderId && !mayHandleTimeout)) {
      trace('game_event_rejected', {
        gameId: room.game_id,
        senderId,
        expectedActorId,
        reason: state ? 'not_actor' : 'no_state',
      })
      return
    }
    const event = message.event
    const validDiceRoll = event?.kind === 'dice-roll'
      && event.playerId === expectedActorId
      && Array.isArray(event.dice) && event.dice.length === 2
      && event.dice.every((value) => Number.isInteger(value) && value >= 1 && value <= 6)
    const validMovement = event?.kind === 'movement'
      && event.playerId === expectedActorId
      && Number.isInteger(event.startPosition) && event.startPosition >= 0 && event.startPosition < 40
      && Number.isInteger(event.steps) && event.steps >= 1 && event.steps <= 40
      && (event.direction === 1 || event.direction === -1)
    const validDirectMovement = event?.kind === 'direct-movement'
      && event.playerId === expectedActorId
      && Number.isInteger(event.startPosition) && event.startPosition >= 0 && event.startPosition < 40
      && Number.isInteger(event.destinationPosition) && event.destinationPosition >= 0 && event.destinationPosition < 40
      && Number.isFinite(event.speedMultiplier) && event.speedMultiplier >= 0.5 && event.speedMultiplier <= 3
    if (!validDiceRoll && !validMovement && !validDirectMovement) {
      trace('game_event_rejected', { gameId: room.game_id, senderId, reason: 'invalid_payload' })
      return
    }
    if (validDiceRoll) {
      rollAuthorizations.set(room.game_id, {
        playerId: expectedActorId,
        steps: event.dice[0] + event.dice[1],
      })
    }
    if (validMovement) {
      const player = state.players.find((item) => item.id === expectedActorId)
      const authorizedRoll = rollAuthorizations.get(room.game_id)
      if (
        player?.position !== event.startPosition ||
        authorizedRoll?.playerId !== expectedActorId || authorizedRoll.steps !== event.steps
      ) {
        trace('game_event_rejected', {
          gameId: room.game_id,
          senderId,
          expectedActorId,
          reason: 'invalid_movement_start',
        })
        return
      }
      const rawDestination = event.startPosition + event.steps * event.direction
      const passedStart = event.direction === 1 && rawDestination >= 40
      movementAuthorizations.set(room.game_id, {
        playerId: expectedActorId,
        destination: (rawDestination + 40 * 2) % 40,
        passedStart,
        lapNumber: (state.lapCounts?.[expectedActorId] ?? 0) + (passedStart ? 1 : 0),
      })
      rollAuthorizations.delete(room.game_id)
    }
    const payload = { type: 'game_event', gameId: room.game_id, eventId: randomUUID(), senderId, event }
    if (validMovement || validDirectMovement) recordLanding(room.game_id, state, event)
    for (const client of clients.keys()) send(client, payload)
    trace('game_event', { gameId: room.game_id, eventId: payload.eventId, senderId, kind: event.kind })
    return
  }

  if (message.type === 'chat_message' && room.status === 'playing' && room.game_id) {
    const text = String(message.text ?? '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 256)
    if (!text) return
    const game = database.prepare('SELECT state_json, updated_at, turn_deadline FROM games WHERE id = ?').get(room.game_id)
    if (!game?.state_json) return
    const state = normalizeEliminatedState(JSON.parse(game.state_json))
    const senderId = publicPlayerId(token)
    const player = state.players?.find((item) => item.id === senderId)
    if (!player) return
    if (text === '!!&& restart') {
      returnGameToLobby(room.game_id, `hidden_restart:${senderId}`)
      return
    }
    const chatEventId = randomUUID()
    const previousState = summarizeGameState(state)
    state.logs = [...(state.logs ?? []), {
      id: chatEventId,
      playerId: senderId,
      text: `${player.name}: ${text}`,
      kind: 'chat',
      time: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date()),
    }]
    const revision = Math.max(Date.now(), Number(game.updated_at ?? 0) + 1)
    database.prepare('UPDATE games SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), revision, room.game_id)
    broadcastGameState(room.game_id, state, revision, game.turn_deadline, 'server')
    trace('chat_message', {
      gameId: room.game_id,
      eventId: chatEventId,
      playerId: senderId,
      before: previousState,
      after: summarizeGameState(state),
    })
    return
  }

  if (message.type === 'game_snapshot' && room.status === 'playing' && room.game_id) {
    const state = message.state
    if (!state || typeof state !== 'object' || !Array.isArray(state.players)) return
    const storedGame = database.prepare('SELECT state_json, updated_at, turn_key, turn_deadline FROM games WHERE id = ?').get(room.game_id)
    const storedState = storedGame?.state_json ? JSON.parse(storedGame.state_json) : null
    // Клиент не может удалить отметки уже выданных сервером наград.
    state.serverEconomy = storedState?.serverEconomy ?? { rewardKeys: [] }
    preservePendingServerRewards(storedState, state)
    const expectedPlayerIds = storedState?.players?.map((player) => player.id)
      ?? sessionRows().filter((item) => item.seat !== null).map((item) => publicPlayerId(item.token))
    const validationError = validateGameState(state, expectedPlayerIds) ??
      (!storedState ? validateInitialGameState(state) : null)
    if (validationError) {
      const senderId = publicPlayerId(token)
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: validationError,
      })
      send(socket, { type: 'action_error', message: 'Сервер отклонил некорректное состояние игры' })
      return
    }
    // Chat messages are appended by the server. A gameplay snapshot may have
    // been prepared just before a chat message arrived, so never let that
    // slightly older snapshot erase server-owned log entries.
    if (storedState && Array.isArray(storedState.logs)) {
      const incomingLogs = Array.isArray(state.logs) ? state.logs : []
      const storedLogIds = new Set(storedState.logs.map((entry) => entry?.id).filter(Boolean))
      state.logs = [
        ...storedState.logs,
        ...incomingLogs.filter((entry) => !entry?.id || !storedLogIds.has(entry.id)),
      ]
    }
    const previousActorId = getTurnActorId(storedState)
    const senderId = publicPlayerId(token)
    const initialActivePlayer = state.players?.[state.activePlayerIndex]
    const mayInitialize = !storedState && initialActivePlayer?.id === senderId
    const mayUpdate = previousActorId === senderId
    const previousTradeTarget = storedState?.tradeDraft?.stage === 'review' ? storedState.tradeDraft.targetPlayerId : null
    const mayAnswerTrade = previousTradeTarget === senderId
    const timeoutController = timeoutControllers.get(room.game_id)
    const submittedTimeoutId = typeof message.timeoutId === 'string' ? message.timeoutId : null
    const isParticipant = Boolean(storedState?.players?.some((player) => player.id === senderId))
    const mayHandleTimeout = Boolean(
      isParticipant &&
      submittedTimeoutId &&
      timeoutController?.timeoutId === submittedTimeoutId &&
      timeoutController.turnKey === storedGame?.turn_key &&
      timeoutController.claimedBy === senderId,
    )
    const previousEliminatedIds = new Set(storedState?.eliminatedPlayerIds ?? [])
    const submittedEliminatedIds = new Set(state.eliminatedPlayerIds ?? [])
    const allowedNewEliminatedId = mayHandleTimeout
      ? storedState?.players?.[storedState.activePlayerIndex]?.id
      : senderId
    const invalidElimination = !storedState
      ? submittedEliminatedIds.size > 0
      : [...previousEliminatedIds].some((id) => !submittedEliminatedIds.has(id)) ||
        [...submittedEliminatedIds].some((id) =>
          !previousEliminatedIds.has(id) && id !== allowedNewEliminatedId)
    if (invalidElimination) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: 'invalid_elimination',
      })
      send(socket, { type: 'action_error', message: 'Сервер отклонил некорректное исключение игрока' })
      return
    }
    const newlyEliminatedIds = [...submittedEliminatedIds]
      .filter((id) => !previousEliminatedIds.has(id))
    settleBalancesForElimination(storedState, state, newlyEliminatedIds)
    const remainingPlayerIds = state.players
      .map((player) => player.id)
      .filter((playerId) => !submittedEliminatedIds.has(playerId))
    state.winnerId = remainingPlayerIds.length === 1 ? remainingPlayerIds[0] : null
    normalizeEliminatedState(state)
    const deadlineExpired = Boolean(storedGame?.turn_deadline && storedGame.turn_deadline <= Date.now())
    if ((submittedTimeoutId && !mayHandleTimeout) || (deadlineExpired && !mayHandleTimeout)) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: submittedTimeoutId ? 'invalid_timeout_id' : 'decision_expired',
      })
      return
    }
    if (!mayInitialize && !mayUpdate && !mayAnswerTrade && !mayHandleTimeout) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        expectedActorId: previousActorId,
      })
      return
    }
    const tradeResolutionError = storedState
      ? validateTradeResolution(storedState, state, senderId)
      : null
    if (tradeResolutionError) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: tradeResolutionError,
      })
      send(socket, { type: 'action_error', message: 'Сервер отклонил некорректный обмен' })
      return
    }
    const economyTransitionError = storedState
      ? validatePurchaseTransition(storedState, state) ??
        validateAuctionTransition(storedState, state) ??
        validateCasinoTransition(storedState, state) ??
        validatePendingPaymentTransition(storedState, state) ??
        validatePendingTileTransition(storedState, state) ??
        validatePropertyTransition(storedState, state, senderId, mayHandleTimeout) ??
        validateMoneyTransition(storedState, state, senderId, movementAuthorizations.get(room.game_id))
      : null
    if (economyTransitionError) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: economyTransitionError,
      })
      send(socket, { type: 'action_error', message: 'Сервер отклонил некорректную денежную операцию' })
      return
    }

    const previousTradeRequests = Math.max(
      0,
      Math.trunc(Number(storedState?.tradeRequestsThisTurn) || 0),
    )
    const sameTurn = Boolean(storedState) && state.turnSequence === storedState.turnSequence
    const opensTradeReview = storedState?.tradeDraft?.stage !== 'review'
      && state.tradeDraft?.stage === 'review'
    if (opensTradeReview && (!sameTurn || senderId !== previousActorId)) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: 'invalid_trade_transition',
      })
      return
    }
    const startsTradeReview = sameTurn && opensTradeReview
    if (startsTradeReview && previousTradeRequests >= 3) {
      trace('snapshot_rejected', {
        gameId: room.game_id,
        senderId,
        reason: 'trade_limit_reached',
      })
      return
    }
    state.tradeRequestsThisTurn = !storedState || !sameTurn
      ? 0
      : startsTradeReview
        ? previousTradeRequests + 1
        : previousTradeRequests

    const authoritativeMissedTurns = { ...(storedState?.missedTurnCounts ?? {}) }
    if (!storedState) {
      state.missedTurnCounts = {}
    } else if (mayHandleTimeout && timeoutCountsAsMissedTurn(storedState)) {
      const timedOutPlayerId = storedState.players[storedState.activePlayerIndex]?.id
      const missedTurns = Math.min(3, (authoritativeMissedTurns[timedOutPlayerId] ?? 0) + 1)
      authoritativeMissedTurns[timedOutPlayerId] = missedTurns
      state.missedTurnCounts = authoritativeMissedTurns

      if (missedTurns >= 3) {
        state.eliminatedPlayerIds = [...new Set([...(state.eliminatedPlayerIds ?? []), timedOutPlayerId])]
        const remainingPlayers = state.players.filter((player) => !state.eliminatedPlayerIds.includes(player.id))
        if (remainingPlayers.length === 1) state.winnerId = remainingPlayers[0].id
        normalizeEliminatedState(state)
        trace('player_eliminated_by_timeouts', {
          gameId: room.game_id,
          playerId: timedOutPlayerId,
          missedTurns,
        })
      }
    } else {
      state.missedTurnCounts = authoritativeMissedTurns
    }

    const revision = Math.max(Date.now(), Number(storedGame?.updated_at ?? 0) + 1)
    const turnKey = getTurnKey(state)
    const decisionDuration = state.tradeDraft?.stage === 'review'
      ? tradeDecisionDuration
      : state.auction
        ? auctionDecisionDuration
        : turnDuration
    const turnDeadline = turnKey === storedGame?.turn_key && storedGame?.turn_deadline
      ? storedGame.turn_deadline
      : revision + decisionDuration
    timeoutControllers.delete(room.game_id)
    turnActionControllers.delete(room.game_id)
    database.prepare('UPDATE games SET state_json = ?, updated_at = ?, turn_key = ?, turn_deadline = ? WHERE id = ?')
      .run(JSON.stringify(state), revision, turnKey, turnDeadline, room.game_id)
    const movementAuthorization = movementAuthorizations.get(room.game_id)
    if (movementAuthorization) {
      const rewardKey = `start:${movementAuthorization.playerId}:${movementAuthorization.lapNumber}`
      if (!movementAuthorization.passedStart || state.serverEconomy?.rewardKeys?.includes(rewardKey)) {
        movementAuthorizations.delete(room.game_id)
      }
    }
    broadcastGameState(room.game_id, state, revision, turnDeadline, senderId)
    trace('snapshot', {
      gameId: room.game_id,
      revision,
      playerId: senderId,
      turnKey,
      before: summarizeGameState(storedState),
      after: summarizeGameState(state),
    })
    if (state.winnerId) scheduleGameReturnToLobby(room.game_id)
    return
  }

  if (message.type === 'return_to_lobby' && room.status === 'playing' && room.game_id) {
    const game = database.prepare('SELECT state_json FROM games WHERE id = ?').get(room.game_id)
    const state = game?.state_json ? JSON.parse(game.state_json) : null
    if (!state?.winnerId) return
    returnGameToLobby(room.game_id, 'game_finished')
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
    if (nickname.length < 1) {
      send(socket, { type: 'action_error', message: 'Ник не может быть пустым' })
      return
    }
    database.prepare('UPDATE sessions SET nickname = ?, ready = 0, last_seen = ? WHERE token = ?')
      .run(nickname, Date.now(), token)
  }

  if (message.type === 'set_ready' && room.status === 'lobby' && session.seat !== null) {
    database.prepare('UPDATE sessions SET ready = ?, last_seen = ? WHERE token = ?')
      .run(message.ready ? 1 : 0, Date.now(), token)
    trace('lobby_ready_changed', { playerId: publicPlayerId(token), ready: Boolean(message.ready) })
  }

  if (message.type === 'lobby_activity' && room.status !== 'lobby') return

  reconcileCountdown()
  broadcastLobby()
}

const server = createServer(async (request, response) => {
  if (request.url === '/api/version' && request.method === 'GET') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ version: appVersion }))
    return
  }

  if (request.url === '/api/access' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request)
      if (!verifyPassword(body.password)) {
        response.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify({ ok: false, message: 'Неверный пароль' }))
        return
      }
      const forwardedProtocol = String(request.headers['x-forwarded-proto'] ?? '')
      const secure = request.socket.encrypted || forwardedProtocol.split(',')[0].trim() === 'https'
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `${accessCookieName}=${encodeURIComponent(accessCookieValue)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`,
      })
      response.end(JSON.stringify({ ok: true }))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: false, message: 'Некорректный запрос' }))
    }
    return
  }

  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true, version: appVersion }))
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

const webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 })
webSocketServer.on('connection', (socket, request) => {
  socket.hasAccess = hasAccessCookie(request)
  socket.isAlive = true
  socket.on('pong', () => { socket.isAlive = true })
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
    const request = claimRequest(token, message)
    if (request.invalid) {
      send(socket, { type: 'action_error', message: 'Некорректный идентификатор запроса' })
      return
    }
    if (!request.accepted) {
      trace('duplicate_request_ignored', {
        gameId: roomRow().game_id ?? null,
        playerId: publicPlayerId(token),
        eventId: request.requestId,
        messageType: message.type,
      })
      return
    }
    handleLobbyMessage(socket, token, message)
  })

  socket.on('close', () => {
    clearTimeout(authTimeout)
    const token = clients.get(socket)
    clients.delete(socket)
    clientPresence.delete(socket)
    if (token && ![...clients.values()].includes(token)) {
      const membership = roomStore.getMembership(token)
      if (membership) {
        const multiplayerRoom = roomStore.getRoom(membership.room_id)
        database.prepare('UPDATE sessions SET connected = 0, last_seen = ? WHERE token = ?')
          .run(Date.now(), token)
        if (multiplayerRoom?.status === 'lobby') {
          database.prepare('UPDATE room_members SET ready = 0, last_active_at = ? WHERE session_token = ?')
            .run(Date.now(), token)
        }
        broadcastMultiplayerLobby(membership.room_id)
      } else {
        if (legacySingleRoom) {
          const room = roomRow()
          database.prepare(`
            UPDATE sessions SET connected = 0, ready = CASE WHEN ? = 'lobby' THEN 0 ELSE ready END, last_seen = ?
            WHERE token = ?
          `).run(room.status, Date.now(), token)
          if (room.status === 'lobby') reconcileCountdown()
          broadcastLobby()
        } else {
          database.prepare('UPDATE sessions SET connected = 0, last_seen = ? WHERE token = ?')
            .run(Date.now(), token)
        }
      }
    }
  })
})

const heartbeatTimer = setInterval(() => {
  for (const socket of webSocketServer.clients) {
    if (socket.isAlive === false) {
      socket.terminate()
      continue
    }
    socket.isAlive = false
    socket.ping()
  }
}, 30000)
heartbeatTimer.unref()
webSocketServer.on('close', () => clearInterval(heartbeatTimer))

setInterval(() => {
  if (!legacySingleRoom) return
  if (roomRow().status !== 'lobby') return
  const now = Date.now()
  const disconnectedBefore = now - lobbyDisconnectDuration
  const idleBefore = now - lobbyIdleDuration
  const disconnectedResult = database.prepare(`
    UPDATE sessions SET seat = NULL, ready = 0
    WHERE connected = 0 AND seat IS NOT NULL AND last_seen < ?
  `).run(disconnectedBefore)
  const idleResult = database.prepare(`
    UPDATE sessions SET seat = NULL, ready = 0
    WHERE connected = 1 AND seat IS NOT NULL AND last_seen < ?
  `).run(idleBefore)
  if (disconnectedResult.changes || idleResult.changes) {
    trace('lobby_seats_released', {
      disconnected: disconnectedResult.changes,
      idle: idleResult.changes,
    })
  }
  reconcileCountdown()
}, 1000).unref()

setInterval(() => {
  database.prepare('DELETE FROM processed_requests WHERE created_at < ?')
    .run(Date.now() - 24 * 60 * 60 * 1000)
}, 60 * 60 * 1000).unref()

setInterval(() => {
  if (!legacySingleRoom) return
  const room = roomRow()
  if (room.status !== 'playing' || !room.game_id) return
  const game = database.prepare('SELECT state_json, turn_key, turn_deadline FROM games WHERE id = ?').get(room.game_id)
  if (!game?.state_json || !game.turn_deadline || game.turn_deadline > Date.now()) return

  const state = JSON.parse(game.state_json)
  if (state.winnerId) {
    scheduleGameReturnToLobby(room.game_id)
    return
  }
  const actorId = getTurnActorId(state)
  const participantIds = new Set(state.players?.map((player) => player.id) ?? [])
  const participantSockets = [...clients.entries()].filter(([, token]) =>
    participantIds.has(publicPlayerId(token)))
  if (participantSockets.length === 0) return
  const now = Date.now()
  const existingController = timeoutControllers.get(room.game_id)
  const controller = existingController?.turnKey === game.turn_key
    ? existingController
    : {
        timeoutId: randomUUID(),
        turnKey: game.turn_key,
        lastSentAt: 0,
        claimedBy: null,
        claimExpiresAt: 0,
        attemptedHandlerIds: new Set(),
      }
  if (!(controller.attemptedHandlerIds instanceof Set)) controller.attemptedHandlerIds = new Set()
  if (controller.claimedBy && controller.claimExpiresAt > now) return
  if (controller.claimedBy) controller.attemptedHandlerIds.add(controller.claimedBy)
  if (now - controller.lastSentAt < 1000) return

  const orderedSockets = [...participantSockets].sort(([firstSocket], [secondSocket]) =>
    Number(clientPresence.get(secondSocket)?.visible === true) -
    Number(clientPresence.get(firstSocket)?.visible === true))
  let handler = orderedSockets.find(([, token]) =>
    !controller.attemptedHandlerIds.has(publicPlayerId(token)))
  if (!handler) {
    controller.attemptedHandlerIds.clear()
    handler = orderedSockets[0]
  }
  if (!handler) return

  const [handlerSocket, handlerToken] = handler
  const handlerId = publicPlayerId(handlerToken)
  controller.claimedBy = handlerId
  controller.claimExpiresAt = now + 10000
  controller.lastSentAt = now
  timeoutControllers.set(room.game_id, controller)
  trace('turn_timeout_assigned', {
    gameId: room.game_id,
    actorId,
    handlerId,
    handlerVisible: clientPresence.get(handlerSocket)?.visible === true,
    timeoutId: controller.timeoutId,
  })
  send(handlerSocket, {
    type: 'turn_timeout_granted',
    gameId: room.game_id,
    turnKey: game.turn_key,
    timeoutId: controller.timeoutId,
    actorId,
  })
}, 500).unref()

server.listen(port, host, () => {
  console.log(`Monopoly online server v${appVersion}: http://${host}:${port}`)
})
