import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

const port = 3100 + Math.floor(Math.random() * 500)
const expectedVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
const dataDirectory = mkdtempSync(join(tmpdir(), 'monopoly-online-'))
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    GAME_PASSWORD: 'integration',
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
const connect = async (auth) => {
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
  await waitForServer
  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/version`)
  assert.equal(versionResponse.status, 200, 'Сервер должен отдавать версию приложения')
  assert.equal(
    (await versionResponse.json()).version,
    expectedVersion,
    'Версии package.json и сервера должны совпадать',
  )

  const accessResponse = await fetch(`http://127.0.0.1:${port}/api/access`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'integration' }),
  })
  assert.equal(accessResponse.status, 200, 'Пароль должен создавать cookie доступа')
  const accessCookie = accessResponse.headers.get('set-cookie')?.split(';')[0]
  assert.ok(accessCookie, 'Сервер должен вернуть cookie доступа')
  const cookieSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: accessCookie } })
  track(cookieSocket)
  await once(cookieSocket, 'open')
  cookieSocket.send(JSON.stringify({ type: 'auth' }))
  const cookieAuth = await waitFor(cookieSocket, (message) => message.type === 'auth_ok')
  assert.ok(cookieAuth.token, 'Новая вкладка должна войти по cookie без повторного пароля')
  cookieSocket.close()

  const first = await connect({ password: 'integration' })
  const second = await connect({ password: 'integration' })
  send(first, { type: 'claim_seat', seat: 0 })
  send(second, { type: 'claim_seat', seat: 1 })
  send(first, { type: 'set_nickname', nickname: 'Н' })
  const renamedLobby = await waitFor(second.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats[0]?.nickname === 'Н')
  assert.equal(renamedLobby.lobby.seats[0].ready, false, 'Смена ника должна снимать готовность')

  const temporary = await connect({ password: 'integration' })
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
  const idle = await connect({ password: 'integration' })
  send(idle, { type: 'claim_seat', seat: 2 })
  const idleLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.seats[2]?.playerId)
  assert.ok(idleLobby.lobby.seats[2].idleExpiresAt > Date.now(), 'Для подключённого места нужен срок неактивности')
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && !message.lobby.seats[2]?.playerId, 7000)
  clearInterval(keepLobbyAlive)
  idle.socket.close()

  const third = await connect({ password: 'integration' })
  const fourth = await connect({ password: 'integration' })
  const fifth = await connect({ password: 'integration' })
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
  send(first, { type: 'turn_action_started' })
  const lockedTurn = await waitFor(second.socket, (message) => message.type === 'turn_deadline')
  assert.ok(lockedTurn.turnDeadline - Date.now() > 25000, 'Нажатие броска должно блокировать старый таймер на время действия')
  send(first, {
    type: 'game_snapshot',
    state: {
      ...state,
      auction: {
        tileId: 1,
        participantIds: ids,
        activeBidderId: ids[0],
        currentBid: 600,
        highestBidderId: null,
        passedIds: [],
      },
    },
  })
  const auctionSnapshot = await waitFor(second.socket, (message) =>
    message.type === 'game_state' && message.state.auction?.activeBidderId === ids[0])
  assert.ok(auctionSnapshot.turnDeadline - Date.now() > 1000, 'Аукционный таймер должен учитывать AUCTION_SECONDS')
  assert.ok(auctionSnapshot.turnDeadline - Date.now() <= 2200, 'Аукционный таймер не должен использовать время обычного хода')
  const auctionTimeoutOffer = await waitFor(first.socket, (message) =>
    message.type === 'turn_timeout' && message.actorId === ids[0], 4000)
  send(first, { type: 'turn_timeout_claim', timeoutId: auctionTimeoutOffer.timeoutId })
  const auctionTimeout = await waitFor(first.socket, (message) =>
    message.type === 'turn_timeout_granted' && message.timeoutId === auctionTimeoutOffer.timeoutId, 4000)
  assert.equal(auctionTimeout.actorId, ids[0], 'По таймеру должен выйти текущий участник аукциона')
  send(first, { type: 'game_snapshot', timeoutId: auctionTimeout.timeoutId, state })
  await waitFor(second.socket, (message) => message.type === 'game_state' && message.state.auction === null)
  send(first, { type: 'game_event', event: { kind: 'movement', playerId: ids[0], startPosition: 0, steps: 6, direction: 1 } })
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
  send(second, { type: 'chat_message', text: 'Привет' })
  const chatSnapshot = await waitFor(first.socket, (message) => message.type === 'game_state' && message.state.logs?.some((entry) => entry.kind === 'chat'))
  assert.equal(chatSnapshot.state.players[0].money, 15000, 'Неактивный игрок не должен перезаписывать состояние')
  second.socket.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const reconnected = await connect({ token: second.token })
  const restored = await waitFor(reconnected.socket, (message) => message.type === 'game_state' && message.state.logs?.length)
  send(first, {
    type: 'game_snapshot',
    state: {
      ...restored.state,
      tradeDraft: {
        targetPlayerId: ids[1], offeredMoney: 0, requestedMoney: 0,
        offeredTileIds: [], requestedTileIds: [], stage: 'draft',
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
        targetPlayerId: ids[1], offeredMoney: 0, requestedMoney: 0,
        offeredTileIds: [], requestedTileIds: [], stage: 'review',
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
      owners: { ...tradeReview.state.owners, 13: ids[1] },
      propertyLevels: { ...tradeReview.state.propertyLevels, 13: 2 },
      tradeDraft: null,
      eliminatedPlayerIds: [ids[1]],
      winnerId: ids[0],
    },
  })
  const eliminatedSnapshot = await waitFor(first.socket, (message) =>
    message.type === 'game_state' && message.state.winnerId === ids[0])
  const eliminatedPlayer = eliminatedSnapshot.state.players.find((player) => player.id === ids[1])
  assert.equal(eliminatedPlayer.money, 0, 'Баланс выбывшего игрока должен быть обнулён сервером')
  assert.equal(eliminatedPlayer.lastDelta, 0, 'Последнее изменение баланса выбывшего должно быть обнулено')
  assert.equal(eliminatedSnapshot.state.owners[13], undefined, 'Поля выбывшего должны вернуться Банку')

  queues.set(first.socket, queues.get(first.socket).filter((message) =>
    message.type !== 'lobby' || message.lobby.status !== 'lobby'))
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
  for (let missedTurn = 1; missedTurn <= 3; missedTurn += 1) {
    const timeoutOffer = await waitFor(first.socket, (message) =>
      message.type === 'turn_timeout' && message.gameId === timeoutGame.lobby.gameId, 7000)
    send(first, { type: 'turn_timeout_claim', timeoutId: timeoutOffer.timeoutId })
    const timeout = await waitFor(first.socket, (message) =>
      message.type === 'turn_timeout_granted' && message.timeoutId === timeoutOffer.timeoutId, 4000)
    send(first, {
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
}
