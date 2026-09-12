import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServerClock } from '../shared/server-clock.mjs'
import { validateAuctionTransition } from '../server/game-state-validation.mjs'

test('two clients with a 27-second wall-clock difference show the same countdown', () => {
  let elapsed = 0
  let firstWall = 1_000_000
  const first = createServerClock(() => elapsed, () => firstWall)
  const second = createServerClock(() => elapsed + 7000, () => firstWall + 27000)
  const serverTime = 2_000_000
  first.sync(serverTime)
  second.sync(serverTime)
  const deadline = serverTime + 40000
  for (const step of [0, 5000, 31000, 40000]) {
    elapsed = step
    assert.equal(Math.ceil((deadline - first.now()) / 1000), Math.ceil((deadline - second.now()) / 1000))
    assert.equal(first.now(), serverTime + step)
  }
  firstWall += 3600000
  elapsed += 1000
  assert.equal(first.now(), serverTime + elapsed, 'Changing the OS clock does not move the game timer')
  first.sync(undefined)
  assert.equal(first.now(), serverTime + elapsed, 'Older messages without a timestamp do not reset the clock')
})

const auctionState = () => ({
  players: ['owner', 'a', 'b', 'c'].map((id) => ({ id, money: 2000 })),
  activePlayerIndex: 0,
  turnSequence: 1,
  owners: {}, propertyLevels: {}, mortgagedPropertyIds: [], eliminatedPlayerIds: [],
  auction: {
    tileId: 1, participantIds: ['a', 'b', 'c'], activeBidderId: 'a',
    currentBid: 600, highestBidderId: null, passedIds: [],
  },
})

test('bid and pass advance to the next eligible bidder without changing the main turn', () => {
  const previous = auctionState()
  const bid = structuredClone(previous)
  Object.assign(bid.auction, { currentBid: 700, highestBidderId: 'a', activeBidderId: 'b' })
  assert.equal(validateAuctionTransition(previous, bid), null)
  const pass = structuredClone(previous)
  Object.assign(pass.auction, { passedIds: ['a'], activeBidderId: 'b' })
  assert.equal(validateAuctionTransition(previous, pass), null)
  for (const patch of [
    { activeBidderId: 'a' }, { activeBidderId: 'c' }, { passedIds: ['b'] },
    { participantIds: ['a', 'c'] }, { currentBid: 2100 }, { tileId: 3 },
  ]) {
    const invalid = structuredClone(bid)
    Object.assign(invalid.auction, patch)
    assert.notEqual(validateAuctionTransition(previous, invalid), null)
  }
  assert.notEqual(validateAuctionTransition(previous, { ...bid, turnSequence: 2 }), null)
  assert.notEqual(validateAuctionTransition(previous, { ...previous, auction: null }), null)
  const prematureSale = {
    ...previous,
    auction: null, owners: { 1: 'a' },
    players: previous.players.map((player) => player.id === 'a' ? { ...player, money: 1300 } : player),
  }
  assert.notEqual(validateAuctionTransition(previous, prematureSale), null, 'Other eligible bidders must get their decision')
})

test('players who passed, lead the bidding or cannot afford the next bid are skipped', () => {
  const previous = auctionState()
  previous.players.find((player) => player.id === 'b').money = 700
  const next = structuredClone(previous)
  Object.assign(next.auction, { currentBid: 700, highestBidderId: 'a', activeBidderId: 'c' })
  assert.equal(validateAuctionTransition(previous, next), null)
  const passed = structuredClone(next)
  Object.assign(passed.auction, { passedIds: ['c'], activeBidderId: 'a' })
  assert.notEqual(validateAuctionTransition(next, passed), null, 'The highest bidder cannot bid against themselves')
})
