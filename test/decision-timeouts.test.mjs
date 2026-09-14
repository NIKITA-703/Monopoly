import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveDecisionTimeout } from '../server/decision-timeouts.mjs'
import { validateAuctionTransition, validateTradeResolution } from '../server/game-state-validation.mjs'

const initial = () => ({
  players: ['owner', 'a', 'b'].map((id) => ({ id, name: id, money: 2000 })),
  activePlayerIndex: 0, turnSequence: 1, hasExtraRoll: false,
  owners: {}, propertyLevels: {}, mortgagedPropertyIds: [], mortgageExpiryTurns: {},
  eliminatedPlayerIds: [], playerEffects: {}, missedTurnCounts: {}, tradeRequestsThisTurn: 1,
  auction: { tileId: 1, participantIds: ['a', 'b'], activeBidderId: 'a', currentBid: 600, highestBidderId: null, passedIds: [] },
})

test('an auction pass advances the bidder and the final pass ends the auction', () => {
  const previous = initial()
  const next = resolveDecisionTimeout(previous).state
  assert.equal(next.auction.activeBidderId, 'b')
  assert.equal(validateAuctionTransition(previous, next), null)
  const finished = resolveDecisionTimeout(next).state
  assert.equal(finished.auction, null)
  assert.equal(finished.activePlayerIndex, 1)
  assert.equal(finished.turnSequence, 2)
  assert.equal(finished.tradeRequestsThisTurn, 0)
  assert.deepEqual(finished.missedTurnCounts, {})
  assert.deepEqual(finished.owners, {})
  assert.equal(previous.auction.passedIds.length, 0, 'The saved state is not mutated')
})

test('a timeout awards the existing high bid once and retains an extra roll', () => {
  const previous = initial()
  Object.assign(previous.auction, { activeBidderId: 'b', highestBidderId: 'a', currentBid: 700 })
  previous.playerEffects.a = { bookChallenge: 2 }
  previous.hasExtraRoll = true
  const next = resolveDecisionTimeout(previous).state
  assert.equal(validateAuctionTransition(previous, next), null)
  assert.equal(next.owners[1], 'a')
  assert.equal(next.players[1].money, 1300)
  assert.equal(next.playerEffects.a.bookChallenge, false)
  assert.equal(next.activePlayerIndex, 0)
  assert.equal(next.turnSequence, 1)
  assert.equal(next.hasExtraRoll, false)
  assert.equal(resolveDecisionTimeout(next), null)
})

test('finishing an auction expires mortgages and honours skipped or eliminated players', () => {
  const previous = initial()
  previous.auction.passedIds = ['b']
  previous.owners[3] = 'owner'
  previous.propertyLevels[3] = 0
  previous.mortgagedPropertyIds = [3]
  previous.mortgageExpiryTurns[3] = 2
  previous.playerEffects.a = { skipTurns: 1 }
  const next = resolveDecisionTimeout(previous).state
  assert.equal(next.activePlayerIndex, 2)
  assert.equal(next.playerEffects.a.skipTurns, 0)
  assert.equal(next.owners[3], undefined)
  assert.deepEqual(next.mortgagedPropertyIds, [])
})

test('trade timeout only closes the offer; it never accepts or charges a player', () => {
  const previous = initial()
  previous.auction = null
  previous.tradeDraft = { stage: 'review', targetPlayerId: 'b', offeredMoney: 100, requestedMoney: 500, offeredTileIds: [], requestedTileIds: [] }
  const next = resolveDecisionTimeout(previous).state
  assert.equal(next.tradeDraft, null)
  assert.deepEqual(next.players, previous.players)
  assert.equal(next.activePlayerIndex, previous.activePlayerIndex)
  assert.equal(next.tradeRequestsThisTurn, 1)
  assert.equal(next.turnSequence, previous.turnSequence)
  assert.equal(validateTradeResolution(previous, { ...previous, tradeDraft: { ...previous.tradeDraft, requestedMoney: 1 } }, 'b'), 'invalid_trade_review_change')
})

test('resending unchanged auction state is allowed without inventing a bid', () => {
  const state = initial()
  assert.equal(validateAuctionTransition(state, structuredClone(state)), null)
})
