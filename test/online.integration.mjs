import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createAuditLog } from '../server/audit-log.mjs'
import { validateAuctionTransition } from '../server/game-state-validation.mjs'

const port = 3100 + Math.floor(Math.random() * 500)
const expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
const dataDirectory = mkdtempSync(join(tmpdir(), 'monopoly-online-'))
const auditTestDirectory = mkdtempSync(join(tmpdir(), 'monopoly-audit-'))
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
      LEGACY_SINGLE_ROOM: '1',
    TURN_SECONDS: '5',
    AUCTION_SECONDS: '2',
    LOBBY_DISCONNECT_SECONDS: '1',
    LOBBY_IDLE_SECONDS: '4',
    DATA_DIR: dataDirectory,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})

const waitForServer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Сервер не запустился')), 5000)
  server.stdout.on('data', (data) => {
    if (String(data).includes('Monopoly online server')) {
      clearTimeout(timer)
      resolve()
    }
  })
})
if (process.env.DEBUG_ONLINE === '1') {
  server.stdout.on('data', (data) => process.stdout.write(data))
}

const queues = new WeakMap()
const listeners = new WeakMap()
const track = (socket) => {
  queues.set(socket, [])
  listeners.set(socket, [])
  socket.on('message', (data) => {
    const message = JSON.parse(String(data))
    const index = listeners.get(socket).findIndex((listener) => listener.predicate(message))
    if (index >= 0) listeners.get(socket).splice(index, 1)[0].resolve(message)
    else queues.get(socket).push(message)
  })
}
const waitFor = (socket, predicate, timeout = 8000) => {
  const queued = queues.get(socket)
  const index = queued.findIndex(predicate)
  if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
  return new Promise((resolve, reject) => {
    const listener = { predicate, resolve }
    listeners.get(socket).push(listener)
    setTimeout(() => {
      const index = listeners.get(socket).indexOf(listener)
      if (index >= 0) listeners.get(socket).splice(index, 1)
      reject(new Error('Истекло время ожидания сообщения'))
    }, timeout)
  })
}
const connect = async (auth = {}) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  track(socket)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'auth', ...auth }))
  const response = await waitFor(socket, (message) => message.type === 'auth_ok')
  return { socket, token: response.token }
}
const send = (client, message) => client.socket.send(JSON.stringify(message))

try {
  const soleAuctionState = {
    players: [
      { id: 'seller', money: 1000 },
      { id: 'only-bidder', money: 2000 },
    ],
    activePlayerIndex: 0,
    owners: {},
    propertyLevels: {},
    mortgagedPropertyIds: [],
    mortgageExpiryTurns: {},
    eliminatedPlayerIds: [],
    auction: {
      tileId: 1,
      participantIds: ['only-bidder'],
      activeBidderId: 'only-bidder',
      currentBid: 600,
      highestBidderId: null,
      passedIds: [],
    },
  }
  const soleAuctionPurchase = {
    ...soleAuctionState,
    players: soleAuctionState.players.map((player) =>
      player.id === 'only-bidder' ? { ...player, money: 1300 } : player),
    owners: { 1: 'only-bidder' },
    auction: null,
  }
  assert.equal(
    validateAuctionTransition(soleAuctionState, soleAuctionPurchase),
    null,
    'Единственный участник должен купить поле ровно за стартовую цену +100k',
  )
  assert.equal(
    validateAuctionTransition(soleAuctionState, {
      ...soleAuctionPurchase,
      players: soleAuctionState.players.map((player) =>
        player.id === 'only-bidder' ? { ...player, money: 1200 } : player),
    }),
    'invalid_auction_balance',
    'Единственный участник не должен самостоятельно повышать цену больше чем на 100k',
  )
  assert.equal(
    validateAuctionTransition(soleAuctionState, {
      ...soleAuctionState,
      auction: { ...soleAuctionState.auction, currentBid: 700, highestBidderId: 'only-bidder' },
    }),
    'invalid_auction_action',
    'Единственный участник не должен продолжать торги сам с собой',
  )

  const auditTest = createAuditLog({ directory: auditTestDirectory })
  auditTest.write('redaction_test', {
    gameId: 'test-game',
    playerId: 'test-player',
    token: 'must-not-be-written',
    nested: { password: 'also-secret' },
  })
  const redactedAudit = readFileSync(auditTest.logPath, 'utf8')
  assert.ok(!redactedAudit.includes('must-not-be-written'), 'Журнал не должен сохранять токены')
  assert.ok(!redactedAudit.includes('also-secret'), 'Журнал не должен сохранять пароли')
  assert.ok(redactedAudit.includes('[redacted]'), 'Секретные значения должны заменяться маркером')

  await waitForServer
  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/version`)
  assert.equal(versionResponse.status, 200, 'Сервер должен отдавать версию приложения')
  assert.equal(
    (await versionResponse.json()).version,
    expectedVersion,
    'Версии package.json и сервера должны совпадать',
  )

  const anonymous = await connect()
  assert.ok(anonymous.token, 'Новая вкладка должна получить сессию без общего пароля сервера')
  anonymous.socket.close()

  const first = await connect()
  const second = await connect()
  send(first, { type: 'claim_seat', seat: 0 })
  send(second, { type: 'claim_seat', seat: 1 })
  send(first, { type: 'set_nickname', nickname: 'Н' })
  const renamedLobby = await waitFor(second.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats[0]?.nickname === 'Н')
  assert.equal(renamedLobby.lobby.seats[0].ready, false, 'Смена ника должна снимать готовность')

  const temporary = await connect()
  send(temporary, { type: 'claim_seat', seat: 2 })
  await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.seats[2]?.playerId)
  temporary.socket.close()
  const disconnectedLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats[2]?.playerId && !message.lobby.seats[2].connected)
  assert.ok(
    disconnectedLobby.lobby.seats[2].disconnectedExpiresAt > Date.now(),
    'Сервер должен сообщать срок освобождения отключённого места',
  )
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && !message.lobby.seats[2]?.playerId, 4000)

  const keepLobbyAlive = setInterval(() => {
    send(first, { type: 'lobby_activity' })
    send(second, { type: 'lobby_activity' })
  }, 500)
  const idle = await connect()
  send(idle, { type: 'claim_seat', seat: 2 })
  const idleLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats[2]?.playerId)
  assert.ok(idleLobby.lobby.seats[2].idleExpiresAt > Date.now(), 'Для подключённого места нужен срок неактивности')
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && !message.lobby.seats[2]?.playerId, 7000)
  clearInterval(keepLobbyAlive)
  idle.socket.close()

  const third = await connect()
  const fourth = await connect()
  const fifth = await connect()
  send(third, { type: 'claim_seat', seat: 2 })
  send(fourth, { type: 'claim_seat', seat: 3 })
  send(fifth, { type: 'claim_seat', seat: 4 })
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats.filter((seat) => seat.playerId).length === 5)

  send(first, { type: 'set_ready', ready: true })
  send(second, { type: 'set_ready', ready: true })
  send(third, { type: 'set_ready', ready: true })
  send(fourth, { type: 'set_ready', ready: true })
  send(fifth, { type: 'set_ready', ready: true })
  const playing = await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.status === 'playing')
  const ids = playing.lobby.seats.filter((seat) => seat.playerId).map((seat) => seat.playerId)
  const state = {
    players: ids.map((id, index) => ({ id, name: `P${index + 1}`, money: 15000, position: 0, color: '#fff', avatar: 'P' })),
    activePlayerIndex: 0, turnSequence: 0, pendingTileId: null, pendingPayment: null,
    auction: null, casino: null, tradeDraft: null, owners: {}, propertyLevels: {},
    mortgagedPropertyIds: [], mortgageExpiryTurns: {}, logs: [], lastRoll: null,
    eventPaymentQueue: [], hasExtraRoll: false, jailedPlayerIds: [], jailFailedAttempts: {},
    casinoJackpot: 2000, upgradedGroupsThisTurn: [], playerEffects: {}, lapCounts: {}, tradeRequestsThisTurn: 0,
    missedTurnCounts: {},
    eliminatedPlayerIds: [], winnerId: null,
  }
  send(first, { type: 'game_snapshot', state })
  const initialSnapshot = await waitFor(second.socket, (message) => message.type === 'game_state' && message.state.players)
  assert.equal(initialSnapshot.senderId, ids[0], 'Снимок должен содержать ID отправителя')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...state,
      players: state.players.map((player, index) => index === 0 ? { ...player, money: -1 } : player),
    },
  })
  const invalidMoneyError = await waitFor(first.socket, (message) =>
    message.type === 'action_error' && message.message.includes('некорректное состояние'))
  assert.ok(invalidMoneyError, 'Сервер должен отклонять отрицательный баланс')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...state,
      players: state.players.map((player, index) => index === 0 ? { ...player, money: 15500 } : player),
    },
  })
  const unexplainedMoneyError = await waitFor(first.socket, (message) =>
    message.type === 'action_error' && message.message.includes('денежную операцию'))
  assert.ok(unexplainedMoneyError, 'Даже активный игрок не должен создавать деньги без игровой причины')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...state,
      pendingPayment: { payerId: ids[0], amount: 9999, tileId: 0, kind: 'tax' },
    },
  })
  await waitFor(first.socket, (message) =>
    message.type === 'action_error' && message.message.includes('денежную операцию'))
  send(first, {
    type: 'game_snapshot',
    state: { ...state, eliminatedPlayerIds: [ids[1]] },
  })
  const invalidEliminationError = await waitFor(first.socket, (message) =>
    message.type === 'action_error' && message.message.includes('исключение игрока'))
  assert.ok(invalidEliminationError, 'Игрок не должен исключать другого участника')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...state,
      players: state.players.map((player, index) => index === 0 ? { ...player, position: 3 } : player),
      pendingTileId: 3,
    },
  })
  const firstPurchaseDecision = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.pendingTileId === 3)
  send(first, {
    type: 'game_snapshot',
    state: {
      ...firstPurchaseDecision.state,
      players: firstPurchaseDecision.state.players.map((player, index) =>
        index === 0 ? { ...player, money: 14400 } : player),
      owners: { 3: ids[0] },
      pendingTileId: null,
    },
  })
  const firstPurchase = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.owners?.[3] === ids[0])
  send(first, {
    type: 'game_snapshot',
    state: {
      ...firstPurchase.state,
      activePlayerIndex: 1,
      turnSequence: 1,
    },
  })
  const secondTurn = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.activePlayerIndex === 1 && message.state.turnSequence === 1)
  send(second, {
    type: 'game_snapshot',
    state: {
      ...secondTurn.state,
      players: secondTurn.state.players.map((player, index) => index === 1 ? { ...player, position: 13 } : player),
      pendingTileId: 13,
    },
  })
  const secondPurchaseDecision = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.pendingTileId === 13)
  send(second, {
    type: 'game_snapshot',
    state: {
      ...secondPurchaseDecision.state,
      players: secondPurchaseDecision.state.players.map((player, index) =>
        index === 1 ? { ...player, money: 13600 } : player),
      owners: { ...secondPurchaseDecision.state.owners, 13: ids[1] },
      pendingTileId: null,
    },
  })
  const secondPurchase = await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.owners?.[13] === ids[1])
  send(second, {
    type: 'game_snapshot',
    state: {
      ...secondPurchase.state,
      activePlayerIndex: 0,
      turnSequence: 2,
    },
  })
  const ownedState = (await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.activePlayerIndex === 0 && message.state.turnSequence === 2)).state
  send(first, {
    type: 'game_snapshot',
    state: {
      ...ownedState,
      players: ownedState.players.map((player, index) => index === 0 ? { ...player, money: 15399 } : player),
      mortgagedPropertyIds: [3],
      mortgageExpiryTurns: { 3: 17 },
    },
  })
  await waitFor(first.socket, (message) =>
    message.type === 'action_error' && message.message.includes('денежную операцию'))
  send(first, {
    type: 'game_snapshot',
    state: {
      ...ownedState,
      players: ownedState.players.map((player, index) => index === 0 ? { ...player, money: 14700 } : player),
      mortgagedPropertyIds: [3],
      mortgageExpiryTurns: { 3: 17 },
    },
  })
  const mortgagedSnapshot = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.mortgagedPropertyIds?.includes(3))
  send(first, {
    type: 'game_snapshot',
    state: {
      ...mortgagedSnapshot.state,
      players: mortgagedSnapshot.state.players.map((player, index) =>
        index === 0 ? { ...player, money: 14340 } : player),
      mortgagedPropertyIds: [],
      mortgageExpiryTurns: {},
    },
  })
  const redeemedSnapshot = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.mortgagedPropertyIds?.length === 0 &&
      message.state.players[0].money === 14340)
  send(first, { type: 'turn_action_started' })
  const lockedTurn = await waitFor(second.socket, (message) => message.type === 'turn_deadline')
  assert.ok(lockedTurn.turnDeadline - Date.now() > 25000, 'Нажатие броска должно блокировать старый таймер на время действия')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...redeemedSnapshot.state,
      players: redeemedSnapshot.state.players.map((player, index) =>
        index === 0 ? { ...player, position: 1 } : player),
      pendingTileId: 1,
    },
  })
  const pendingAuctionSnapshot = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.pendingTileId === 1)
  send(first, {
    type: 'game_snapshot',
    state: {
      ...pendingAuctionSnapshot.state,
      pendingTileId: null,
      auction: {
        tileId: 1,
        participantIds: ids.slice(1),
        activeBidderId: ids[1],
        currentBid: 600,
        highestBidderId: null,
        passedIds: [],
      },
    },
  })
  const auctionSnapshot = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.auction?.activeBidderId === ids[1])
  assert.ok(auctionSnapshot.turnDeadline - Date.now() > 1000, 'Аукционный таймер должен учитывать AUCTION_SECONDS')
  assert.ok(auctionSnapshot.turnDeadline - Date.now() <= 2200, 'Аукционный таймер не должен использовать время обычного хода')
  send(second, {
    type: 'game_snapshot',
    state: {
      ...auctionSnapshot.state,
      owners: { ...auctionSnapshot.state.owners, 1: ids[1] },
      auction: null,
    },
  })
  await waitFor(second.socket, (message) =>
    message.type === 'action_error' && message.message.includes('денежную операцию'))
  send(first, { type: 'client_presence', visible: false })
  send(second, { type: 'client_presence', visible: true })
  const auctionTimeout = await waitFor(second.socket, (message) =>
    message.type === 'turn_timeout_granted' && message.actorId === ids[1], 4000)
  assert.equal(
    auctionTimeout.actorId,
    ids[1],
    'Сервер должен поручить таймаут активной вкладке, даже когда ходит другой игрок',
  )
  send(second, { type: 'game_snapshot', timeoutId: auctionTimeout.timeoutId, state: redeemedSnapshot.state })
  await waitFor(second.socket, (message) => message.type === 'game_state' && message.state.auction === null)
  send(first, { type: 'client_presence', visible: true })
  send(second, { type: 'client_presence', visible: false })
  send(first, { type: 'game_event', event: { kind: 'dice-roll', playerId: ids[0], dice: [1, 2] } })
  send(first, { type: 'game_event', event: { kind: 'movement', playerId: ids[0], startPosition: 3, steps: 3, direction: 1 } })
  const movementEvents = await Promise.all([second, third, fourth, fifth].map((client) =>
    waitFor(client.socket, (message) => message.type === 'game_event' && message.event.kind === 'movement')))
  assert.equal(new Set(movementEvents.map((message) => message.eventId)).size, 1, 'Все клиенты должны получить одно событие движения')
  send(first, {
    type: 'game_event',
    event: { kind: 'direct-movement', playerId: ids[0], startPosition: 30, destinationPosition: 10, speedMultiplier: 1.26 },
  })
  const directEvents = await Promise.all([second, third, fourth, fifth].map((client) =>
    waitFor(client.socket, (message) => message.type === 'game_event' && message.event.kind === 'direct-movement')))
  assert.equal(new Set(directEvents.map((message) => message.eventId)).size, 1, 'Прямое движение должно иметь общий ID на всех клиентах')
  assert.notEqual(directEvents[0].eventId, movementEvents[0].eventId, 'Последовательные движения не должны склеиваться')
  assert.equal(directEvents[0].event.startPosition, 30, 'Анимация тюрьмы должна начинаться на полицейском')
  assert.equal(directEvents[0].event.destinationPosition, 10, 'Анимация тюрьмы должна заканчиваться на здании')
  const statisticsDatabase = new DatabaseSync(join(dataDirectory, 'monopoly.sqlite'), { readOnly: true })
  const landingStatistics = statisticsDatabase.prepare(`
    SELECT tile_id, tile_name, player_color, movement_kind FROM landings WHERE game_id = ? ORDER BY id
  `).all(playing.lobby.gameId)
  statisticsDatabase.close()
  assert.deepEqual(
    landingStatistics.map((landing) => [landing.tile_id, landing.tile_name, landing.player_color, landing.movement_kind]),
    [[6, 'Nike', '#fff', 'movement'], [10, 'Тюрьма', '#fff', 'direct-movement']],
    'Сервер должен сохранять поле и цвет игрока для каждого завершённого перемещения',
  )
  send(second, {
    type: 'game_snapshot',
    state: { ...state, players: state.players.map((player, index) => index === 0 ? { ...player, money: 1 } : player) },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const duplicateRequestId = 'integration-duplicate-chat'
  send(second, { type: 'chat_message', text: 'Проверка повтора', requestId: duplicateRequestId })
  send(second, { type: 'chat_message', text: 'Проверка повтора', requestId: duplicateRequestId })
  await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.logs?.some((entry) => entry.text.includes('Проверка повтора')))
  await new Promise((resolve) => setTimeout(resolve, 50))
  const idempotencyDatabase = new DatabaseSync(join(dataDirectory, 'monopoly.sqlite'), { readOnly: true })
  const idempotentState = JSON.parse(idempotencyDatabase.prepare('SELECT state_json FROM games WHERE id = ?')
    .get(playing.lobby.gameId).state_json)
  idempotencyDatabase.close()
  assert.equal(
    idempotentState.logs.filter((entry) => entry.text.includes('Проверка повтора')).length,
    1,
    'Повторная отправка одного запроса не должна выполнять его второй раз',
  )
  send(second, { type: 'chat_message', text: 'Привет' })
  const chatSnapshot = await waitFor(first.socket, (message) => message.type === 'game_state' && message.state.logs?.some((entry) => entry.kind === 'chat'))
  assert.equal(chatSnapshot.state.players[0].money, 14340, 'Неактивный игрок не должен перезаписывать состояние')
  const auditRecords = readFileSync(join(dataDirectory, 'audit', 'game-actions.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const snapshotAudit = auditRecords.find((record) =>
    record.action === 'snapshot' && record.gameId === playing.lobby.gameId && record.before && record.after)
  assert.ok(snapshotAudit?.recordId, 'Сервер должен сохранять структурированную запись изменения состояния')
  assert.equal(snapshotAudit.roomId, 1, 'Запись должна содержать комнату')
  assert.equal(typeof snapshotAudit.turnSequence, 'number', 'Запись должна содержать номер хода')
  assert.equal(typeof snapshotAudit.phase, 'string', 'Запись должна содержать фазу')
  const exportedAudit = spawnSync(process.execPath, ['server/export-game-log.mjs', playing.lobby.gameId], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDirectory },
    encoding: 'utf8',
  })
  assert.equal(exportedAudit.status, 0, 'Выгрузка журнала партии должна завершаться успешно')
  assert.ok(exportedAudit.stdout.includes(playing.lobby.gameId), 'Выгрузка должна содержать только записи партии')
  second.socket.close()
  const reconnectingLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.status === 'playing' &&
    message.lobby.seats[1]?.playerId === ids[1] && !message.lobby.seats[1].connected)
  assert.ok(
    reconnectingLobby.lobby.seats[1].disconnectedExpiresAt > Date.now(),
    'Во время партии сервер должен сообщать срок переподключения игрока',
  )
  const reconnected = await connect({ token: second.token })
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.status === 'playing' && message.lobby.seats[1]?.connected)
  const restored = await waitFor(reconnected.socket, (message) => message.type === 'game_state' && message.state.logs?.length)
  send(first, {
    type: 'game_snapshot',
    state: {
      ...restored.state,
      tradeDraft: {
        targetPlayerId: ids[1], offeredMoney: 100, requestedMoney: 500,
        offeredTileIds: [3], requestedTileIds: [13], stage: 'draft',
      },
    },
  })
  const tradeDraft = await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.tradeDraft?.stage === 'draft')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...tradeDraft.state,
      tradeDraft: {
        targetPlayerId: ids[1], offeredMoney: 100, requestedMoney: 500,
        offeredTileIds: [3], requestedTileIds: [13], stage: 'review',
      },
    },
  })
  const tradeReview = await waitFor(reconnected.socket, (message) => message.type === 'game_state' && message.state.tradeDraft?.stage === 'review')
  assert.equal(tradeReview.state.tradeRequestsThisTurn, 1, 'Отправленный обмен должен расходовать одну из трёх попыток')
  assert.ok(tradeReview.turnDeadline - Date.now() > 30000, 'На решение по обмену должно даваться около 35 секунд')
  assert.ok(tradeReview.turnDeadline - Date.now() <= 36000, 'Таймер обмена не должен превышать 35 секунд')
  send(reconnected, {
    type: 'game_snapshot',
    state: {
      ...tradeReview.state,
      players: tradeReview.state.players.map((player) =>
        player.id === ids[1] ? { ...player, money: 900, lastDelta: 300 } : player),
      owners: { ...tradeReview.state.owners, 13: ids[0] },
      tradeDraft: null,
    },
  })
  await waitFor(reconnected.socket, (message) =>
    message.type === 'action_error' && message.message.includes('некорректный обмен'))
  send(reconnected, {
    type: 'game_snapshot',
    state: {
      ...tradeReview.state,
      players: tradeReview.state.players.map((player) =>
        player.id === ids[0]
          ? { ...player, money: player.money + 400, lastDelta: 400 }
          : player.id === ids[1]
            ? { ...player, money: player.money - 400, lastDelta: -400 }
            : player),
      owners: { ...tradeReview.state.owners, 3: ids[1], 13: ids[0] },
      tradeDraft: null,
    },
  })
  const acceptedTrade = await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.revision > tradeReview.revision && message.state.tradeDraft === null)
  assert.equal(acceptedTrade.state.owners[3], ids[1], 'Сервер должен принять корректную передачу предложенного поля')
  assert.equal(acceptedTrade.state.owners[13], ids[0], 'Сервер должен принять корректную передачу запрошенного поля')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...acceptedTrade.state,
      players: acceptedTrade.state.players.map((player) =>
        player.id === ids[0] ? { ...player, money: 0, lastDelta: 0 } : player),
      activePlayerIndex: 1,
      turnSequence: acceptedTrade.state.turnSequence + 1,
      eliminatedPlayerIds: [ids[0]],
      winnerId: ids[1],
    },
  })
  const eliminatedSnapshot = await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.eliminatedPlayerIds?.includes(ids[0]))
  const eliminatedPlayer = eliminatedSnapshot.state.players.find((player) => player.id === ids[0])
  assert.equal(eliminatedPlayer.money, 0, 'Баланс выбывшего игрока должен быть обнулён сервером')
  assert.equal(eliminatedPlayer.lastDelta, 0, 'Последнее изменение баланса выбывшего должно быть обнулено')
  assert.equal(eliminatedSnapshot.state.winnerId, null, 'Клиент не должен самостоятельно назначать победителя')

  queues.set(first.socket, queues.get(first.socket).filter((message) =>
    message.type !== 'lobby' || message.lobby.status !== 'lobby'))
  send(first, { type: 'chat_message', text: '!!&& restart' })
  await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.status === 'lobby')

  for (const client of [first, reconnected, third, fourth, fifth]) {
    send(client, { type: 'set_ready', ready: true })
  }
  const timeoutGame = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.status === 'playing' && message.lobby.gameId !== playing.lobby.gameId)
  let timeoutState = {
    ...state,
    players: timeoutGame.lobby.seats
      .filter((seat) => seat.playerId)
      .map((seat) => ({
        id: seat.playerId,
        name: seat.nickname,
        money: 15000,
        position: 0,
        color: '#fff',
        avatar: 'P',
      })),
  }
  send(first, { type: 'game_snapshot', state: timeoutState })
  await waitFor(reconnected.socket, (message) =>
    message.type === 'game_state' && message.gameId === timeoutGame.lobby.gameId)
  send(first, { type: 'client_presence', visible: false })
  send(reconnected, { type: 'client_presence', visible: true })
  for (let missedTurn = 1; missedTurn <= 3; missedTurn += 1) {
    const timeout = await waitFor(reconnected.socket, (message) =>
      message.type === 'turn_timeout_granted' && message.gameId === timeoutGame.lobby.gameId, 7000)
    if (missedTurn === 1) {
      send(reconnected, {
        type: 'game_event',
        timeoutId: timeout.timeoutId,
        event: { kind: 'dice-roll', playerId: timeout.actorId, dice: [2, 3] },
      })
      await waitFor(third.socket, (message) =>
        message.type === 'game_event' && message.event.kind === 'dice-roll' && message.event.playerId === timeout.actorId)
    }
    send(reconnected, {
      type: 'game_snapshot',
      timeoutId: timeout.timeoutId,
      state: { ...timeoutState, turnSequence: timeoutState.turnSequence + 1 },
    })
    const timedOutSnapshot = await waitFor(first.socket, (message) =>
      message.type === 'game_state' && message.gameId === timeoutGame.lobby.gameId &&
      (missedTurn < 3
        ? message.state.missedTurnCounts?.[timeout.actorId] === missedTurn
        : message.state.eliminatedPlayerIds?.includes(timeout.actorId)))
    timeoutState = timedOutSnapshot.state
  }
  assert.ok(
    timeoutState.eliminatedPlayerIds.includes(timeoutState.players[0].id),
    'После третьего пропуска сервер обязан исключить игрока из партии',
  )
  send(reconnected, { type: 'chat_message', text: '!!&& restart' })
  await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.status === 'lobby')
  first.socket.close()
  reconnected.socket.close()
  third.socket.close()
  fourth.socket.close()
  fifth.socket.close()
  console.log('Online integration: OK')
} finally {
  server.kill()
  if (server.exitCode === null) await once(server, 'exit')
  rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(auditTestDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
