import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bookBonusAmount, bookChallengeCount, preservePendingBookBonuses } from '../shared/book-bonus.mjs'
import { validateMoneyTransition } from '../server/game-state-validation.mjs'

const stateWithBonus = (bookChallenge) => ({
  players: [{ id: 'reader', money: 15000, position: 39 }],
  activePlayerIndex: 0,
  turnSequence: 1,
  playerEffects: { reader: { bookChallenge } },
  lapCounts: { reader: 0 },
  owners: {}, propertyLevels: {}, mortgagedPropertyIds: [],
  serverEconomy: { rewardKeys: [] },
})
const movement = { playerId: 'reader', passedStart: true, destination: 0, lapNumber: 1 }
const arriving = (previous, reward) => ({
  ...structuredClone(previous),
  players: [{ id: 'reader', money: previous.players[0].money + reward, position: 0 }],
  playerEffects: { reader: { bookChallenge: false } },
  lapCounts: { reader: 1 },
})

test('one challenge pays 1000; repeats add 1000 and saved boolean effects remain valid', () => {
  assert.equal(bookBonusAmount(true), 1000)
  assert.equal(bookBonusAmount(1), 1000)
  assert.equal(bookBonusAmount(bookChallengeCount(true) + 1), 2000)
  assert.equal(bookBonusAmount(3), 3000)
  assert.equal(bookBonusAmount(false), 0)
})

test('server accepts the start reward plus each accumulated challenge and rejects the old amount', () => {
  for (const count of [true, 1, 2, 3, false]) {
    const previous = stateWithBonus(count)
    const next = arriving(previous, 2000 + bookBonusAmount(count))
    assert.equal(validateMoneyTransition(previous, next, 'reader', movement), null)
    assert.ok(next.serverEconomy.rewardKeys.includes('start:reader:1'))
  }
  const previous = stateWithBonus(2)
  assert.notEqual(validateMoneyTransition(previous, arriving(previous, 2500), 'reader', movement), null)
  assert.notEqual(validateMoneyTransition(previous, arriving(previous, 3000), 'reader', movement), null)
})

test('all stacked bonuses survive the intermediate animation snapshot and are consumed once', () => {
  const previous = stateWithBonus(2)
  const intermediate = arriving(previous, 0)
  intermediate.serverEconomy.pendingBookBonusAmounts = preservePendingBookBonuses(previous, intermediate)
  assert.equal(intermediate.serverEconomy.pendingBookBonusAmounts['start:reader:1'], 2000)
  const next = arriving(intermediate, 4000)
  assert.equal(validateMoneyTransition(intermediate, next, 'reader', movement), null)
  assert.equal(next.serverEconomy.pendingBookBonusAmounts['start:reader:1'], undefined)
  assert.notEqual(validateMoneyTransition(next, arriving(next, 4000), 'reader', movement), null)
})

test('cancelled challenges do not create a pending payment, legacy pending keys migrate', () => {
  const previous = stateWithBonus(2)
  const spent = structuredClone(previous)
  spent.players[0].money -= 100
  spent.playerEffects.reader.bookChallenge = false
  assert.deepEqual(preservePendingBookBonuses(previous, spent), {})
  assert.equal(bookBonusAmount(spent.playerEffects.reader.bookChallenge), 0)
  const legacy = stateWithBonus(false)
  legacy.serverEconomy.pendingBookBonusKeys = ['start:reader:1']
  assert.deepEqual(preservePendingBookBonuses(legacy, structuredClone(legacy)), { 'start:reader:1': 1000 })
})
