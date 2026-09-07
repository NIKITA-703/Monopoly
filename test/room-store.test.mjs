import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createRoomStore, installRoomSchema } from '../server/room-store.mjs'

const database = new DatabaseSync(':memory:')
installRoomSchema(database)

let time = 1_000
const codes = ['ROOMA2', 'ROOMB3']
const store = createRoomStore(database, {
  now: () => time += 1,
  generateCode: () => codes.shift(),
})

const firstRoom = store.createRoom({
  leaderToken: 'leader-a',
  name: '  Первая   комната  ',
  visibility: 'private',
  password: 'secret',
})
assert.equal(firstRoom.code, 'ROOMA2')
assert.equal(firstRoom.name, 'Первая комната')
assert.equal(firstRoom.leader_token, 'leader-a')
assert.equal(store.getMembership('leader-a').seat, 0)
assert.equal(store.getMembership('leader-a').ready, 0)

assert.throws(
  () => store.joinRoom({ sessionToken: 'player-b', code: 'room-a2', password: 'wrong' }),
  /invalid_room_password/,
)
const secondMember = store.joinRoom({ sessionToken: 'player-b', code: 'room-a2', password: 'secret' })
assert.equal(secondMember.seat, 1)
assert.equal(store.joinRoom({ sessionToken: 'player-b', code: 'ROOMA2', password: 'secret' }).seat, 1)

for (const token of ['player-c', 'player-d', 'player-e']) {
  store.joinRoom({ sessionToken: token, code: 'ROOMA2', password: 'secret' })
}
assert.deepEqual(store.listMembers(firstRoom.id).map((member) => member.seat), [0, 1, 2, 3, 4])
assert.throws(
  () => store.joinRoom({ sessionToken: 'player-f', code: 'ROOMA2', password: 'secret' }),
  /room_full/,
)

const secondRoom = store.createRoom({ leaderToken: 'leader-b', visibility: 'public' })
assert.equal(secondRoom.code, 'ROOMB3')
assert.equal(secondRoom.name, 'Комната Monopoly')
assert.equal(store.joinRoom({ sessionToken: 'player-g', code: 'ROOMB3' }).seat, 1)
assert.equal(store.listMembers(firstRoom.id).length, 5)
assert.equal(store.listMembers(secondRoom.id).length, 2)
assert.throws(
  () => store.joinRoom({ sessionToken: 'leader-b', code: 'ROOMA2', password: 'secret' }),
  /already_in_room/,
)

database.close()
console.log('Room store: OK')
