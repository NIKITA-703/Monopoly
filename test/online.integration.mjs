import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

const port = 3100 + Math.floor(Math.random() * 500)
const dataDirectory = mkdtempSync(join(tmpdir(), 'monopoly-online-'))
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), GAME_PASSWORD: 'integration', TURN_SECONDS: '5', DATA_DIR: dataDirectory },
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
  const first = await connect({ password: 'integration' })
  const second = await connect({ password: 'integration' })
  send(first, { type: 'claim_seat', seat: 0 })
  send(second, { type: 'claim_seat', seat: 1 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  send(first, { type: 'set_ready', ready: true })
  send(second, { type: 'set_ready', ready: true })
  const playing = await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.status === 'playing')
  const ids = playing.lobby.seats.filter((seat) => seat.playerId).map((seat) => seat.playerId)
  const state = {
    players: ids.map((id, index) => ({ id, name: `P${index + 1}`, money: 15000, position: 0, color: '#fff', avatar: 'P' })),
    activePlayerIndex: 0, turnSequence: 0, pendingTileId: null, pendingPayment: null,
    auction: null, casino: null, tradeDraft: null, owners: {}, propertyLevels: {},
    mortgagedPropertyIds: [], mortgageExpiryTurns: {}, logs: [], lastRoll: null,
    eventPaymentQueue: [], hasExtraRoll: false, jailedPlayerIds: [], jailFailedAttempts: {},
    casinoJackpot: 2000, upgradedGroupsThisTurn: [], playerEffects: {}, lapCounts: {},
    eliminatedPlayerIds: [], winnerId: null,
  }
  send(first, { type: 'game_snapshot', state })
  const initialSnapshot = await waitFor(second.socket, (message) => message.type === 'game_state' && message.state.players)
  assert.equal(initialSnapshot.senderId, ids[0], 'Снимок должен содержать ID отправителя')
  send(first, { type: 'game_event', event: { kind: 'movement', playerId: ids[0], startPosition: 0, steps: 6, direction: 1 } })
  await waitFor(second.socket, (message) => message.type === 'game_event' && message.event.kind === 'movement')
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
        offeredTileIds: [], requestedTileIds: [], stage: 'review',
      },
    },
  })
  const tradeReview = await waitFor(reconnected.socket, (message) => message.type === 'game_state' && message.state.tradeDraft?.stage === 'review')
  assert.ok(tradeReview.turnDeadline - Date.now() > 30000, 'На решение по обмену должно даваться около 35 секунд')
  assert.ok(tradeReview.turnDeadline - Date.now() <= 36000, 'Таймер обмена не должен превышать 35 секунд')
  send(reconnected, {
    type: 'game_snapshot',
    state: { ...tradeReview.state, tradeDraft: null, eliminatedPlayerIds: [ids[1]], winnerId: ids[0] },
  })
  await waitFor(first.socket, (message) => message.type === 'game_state' && message.state.winnerId === ids[0])
  send(reconnected, { type: 'return_to_lobby' })
  await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.status === 'lobby')
  first.socket.close()
  reconnected.socket.close()
  console.log('Online integration: OK')
} finally {
  server.kill()
  if (server.exitCode === null) await once(server, 'exit')
  rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
