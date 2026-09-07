import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const port = 3600 + Math.floor(Math.random() * 400)
const dataDirectory = mkdtempSync(join(tmpdir(), 'monopoly-rooms-'))
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDirectory },
  stdio: ['ignore', 'pipe', 'inherit'],
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

const waitFor = (socket, predicate, timeout = 5000) => {
  const queued = queues.get(socket)
  const index = queued.findIndex(predicate)
  if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
  return new Promise((resolve, reject) => {
    const listener = { predicate, resolve }
    listeners.get(socket).push(listener)
    setTimeout(() => {
      const index = listeners.get(socket).indexOf(listener)
      if (index >= 0) listeners.get(socket).splice(index, 1)
      reject(new Error('Истекло время ожидания сообщения комнаты'))
    }, timeout).unref()
  })
}

const connect = async (auth = {}) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  track(socket)
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'auth', ...auth }))
  const response = await waitFor(socket, (message) => message.type === 'auth_ok')
  return { socket, token: response.token }
}

const send = (client, message) => client.socket.send(JSON.stringify(message))

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Сервер комнат не запустился')), 5000)
    server.stdout.on('data', (data) => {
      if (String(data).includes('Monopoly online server')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  const first = await connect()
  const second = await connect()
  const third = await connect()
  const spectator = await connect()
  await waitFor(spectator.socket, (message) => message.type === 'room_home')

  send(first, {
    type: 'create_room',
    name: 'Закрытая комната',
    visibility: 'private',
    password: 'room-secret',
    requestId: 'create-private-room',
  })
  const firstLobby = await waitFor(first.socket, (message) => message.type === 'lobby' && message.lobby.code)
  assert.equal(firstLobby.lobby.name, 'Закрытая комната')
  assert.equal(firstLobby.lobby.seats.filter((seat) => seat.playerId).length, 1)
  assert.equal(firstLobby.session.isLeader, true)

  send(second, {
    type: 'join_room', code: firstLobby.lobby.code, password: 'wrong', requestId: 'join-wrong-password',
  })
  const wrongPassword = await waitFor(second.socket, (message) => message.type === 'action_error')
  assert.equal(wrongPassword.code, 'invalid_room_password')

  send(second, {
    type: 'join_room', code: firstLobby.lobby.code.toLowerCase(), password: 'room-secret', requestId: 'join-private-room',
  })
  const sharedLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id &&
    message.lobby.seats.filter((seat) => seat.playerId).length === 2)
  assert.ok(sharedLobby.lobby.seats[1].nickname)

  send(first, { type: 'set_ready', ready: true, requestId: 'first-player-ready' })
  const readyLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id && message.session.ready === true)
  assert.equal(readyLobby.lobby.seats[0].ready, true, 'Готовность должна сохраняться внутри выбранной комнаты')

  send(second, { type: 'set_nickname', nickname: 'Второй игрок', requestId: 'rename-second-player' })
  const renamedLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id &&
    message.lobby.seats[1].nickname === 'Второй игрок')
  assert.equal(renamedLobby.lobby.seats[1].ready, false)

  send(second, { type: 'claim_seat', seat: 3, requestId: 'move-second-player' })
  const movedLobby = await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id &&
    message.lobby.seats[3].nickname === 'Второй игрок')
  assert.equal(movedLobby.lobby.seats[1].nickname, null)

  send(third, {
    type: 'create_room', name: 'Другая комната', visibility: 'public', requestId: 'create-public-room',
  })
  const otherLobby = await waitFor(third.socket, (message) => message.type === 'lobby' && message.lobby.code)
  assert.notEqual(otherLobby.lobby.id, firstLobby.lobby.id)
  assert.equal(otherLobby.lobby.visibility, 'public')
  const publicDirectory = await waitFor(spectator.socket, (message) =>
    message.type === 'room_home' && message.rooms.some((room) => room.id === otherLobby.lobby.id))
  assert.deepEqual(
    publicDirectory.rooms.map((room) => [room.id, room.playerCount, room.capacity]),
    [[otherLobby.lobby.id, 1, 5]],
  )
  assert.ok(!queues.get(first.socket).some((message) => message.type === 'lobby' && message.lobby.id === otherLobby.lobby.id))

  second.socket.close()
  await waitFor(first.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id && !message.lobby.seats[1].connected)
  const reconnected = await connect({ token: second.token })
  const restoredLobby = await waitFor(reconnected.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id)
  assert.equal(restoredLobby.session.seat, 3)
  assert.equal(restoredLobby.lobby.code, firstLobby.lobby.code)

  const roomDatabase = new DatabaseSync(join(dataDirectory, 'monopoly.sqlite'), { readOnly: true })
  assert.equal(roomDatabase.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 2)
  assert.equal(roomDatabase.prepare('SELECT COUNT(*) AS count FROM room_members').get().count, 3)
  roomDatabase.close()

  const audit = readFileSync(join(dataDirectory, 'audit', 'game-actions.jsonl'), 'utf8')
  assert.ok(audit.includes('room_created'))
  assert.ok(audit.includes('room_joined'))
  assert.ok(!audit.includes('room-secret'), 'Пароль комнаты не должен попадать в журнал')

  queues.set(first.socket, queues.get(first.socket).filter((message) => message.type !== 'room_home'))
  send(first, { type: 'leave_room', requestId: 'leader-leaves-room' })
  await waitFor(first.socket, (message) => message.type === 'room_home')
  const transferredLeadership = await waitFor(reconnected.socket, (message) =>
    message.type === 'lobby' && message.lobby.id === firstLobby.lobby.id && message.session.isLeader)
  assert.equal(transferredLeadership.lobby.leaderPlayerId, transferredLeadership.session.playerId)

  first.socket.close()
  reconnected.socket.close()
  third.socket.close()
  spectator.socket.close()
  console.log('Room protocol integration: OK')
} finally {
  server.kill()
  if (server.exitCode === null) await once(server, 'exit')
  rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
