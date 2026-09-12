import { BOOK_BONUS_AMOUNT, bookBonusAmount } from '../shared/book-bonus.mjs'

const BOARD_SIZE = 40
const MAX_PROPERTY_LEVEL = 5
const PROPERTY_PRICES = new Map([
  [1, 600], [3, 600], [5, 2000], [6, 1000], [8, 1000], [9, 1200],
  [11, 1400], [12, 1500], [13, 1400], [14, 1600], [15, 2000], [16, 1800],
  [18, 1800], [19, 2000], [21, 2200], [23, 2200], [24, 2400], [25, 2000],
  [26, 2600], [27, 2600], [28, 1500], [29, 2800], [31, 3000], [32, 3000],
  [34, 3200], [35, 2000], [37, 3500], [39, 4000],
])
const BRAND_TILE_IDS = new Set(PROPERTY_PRICES.keys())
const PROPERTY_GROUPS = new Map([
  [1, 'fashion'], [3, 'fashion'], [5, 'automotive'], [6, 'sportswear'], [8, 'sportswear'], [9, 'sportswear'],
  [11, 'gaming'], [12, 'streaming'], [13, 'gaming'], [14, 'gaming'], [15, 'automotive'],
  [16, 'big-tech'], [18, 'big-tech'], [19, 'big-tech'], [21, 'ai'], [23, 'ai'], [24, 'ai'],
  [25, 'automotive'], [26, 'creators'], [27, 'creators'], [28, 'streaming'], [29, 'creators'],
  [31, 'social'], [32, 'social'], [34, 'social'], [35, 'automotive'], [37, 'space'], [39, 'space'],
])
const GROUP_UPGRADE_COSTS = new Map([
  ['fashion', 500], ['sportswear', 500], ['gaming', 750], ['big-tech', 1000],
  ['ai', 1250], ['creators', 1500], ['social', 1750], ['space', 2000],
])
const CHANCE_TILE_IDS = new Set([2, 7, 17, 33, 38])
const DIAMOND_TILE_IDS = new Set([36])
const CASINO_BET = 1000
const INITIAL_CASINO_JACKPOT = 2000
const CASINO_JACKPOT_STEP = 250
const JAIL_RELEASE_COST = 500
const TAX_TILE_IDS = new Set([4, 22])
const SUBSCRIPTION_TILE_IDS = new Set([12, 28])
const FLEET_TILE_IDS = new Set([5, 15, 25, 35])
const PROPERTY_RENTS = new Map([
  [1, [20, 100, 300, 900, 1600, 2500]], [3, [40, 200, 600, 1800, 3200, 4500]],
  [6, [60, 300, 900, 2700, 4000, 5500]], [8, [60, 300, 900, 2700, 4000, 5500]],
  [9, [80, 400, 1000, 3000, 4500, 6000]], [11, [100, 500, 1500, 4500, 6250, 7500]],
  [13, [100, 500, 1500, 4500, 6250, 7500]], [14, [120, 600, 1800, 5000, 7000, 9000]],
  [16, [140, 700, 2000, 5500, 7500, 9500]], [18, [140, 700, 2000, 5500, 7500, 9500]],
  [19, [160, 800, 2200, 6000, 8000, 10000]], [21, [180, 900, 2500, 7000, 8750, 10500]],
  [23, [180, 900, 2500, 7000, 8750, 10500]], [24, [200, 1000, 3000, 7500, 9250, 11000]],
  [26, [220, 1100, 3300, 8000, 9750, 11500]], [27, [220, 1100, 3300, 8000, 9750, 11500]],
  [29, [240, 1200, 3600, 8500, 10250, 12000]], [31, [260, 1300, 3900, 9000, 11000, 12750]],
  [32, [260, 1300, 3900, 9000, 11000, 12750]], [34, [280, 1500, 4500, 10000, 12000, 14000]],
  [37, [350, 1750, 5000, 11000, 13000, 15000]], [39, [500, 2000, 6000, 14000, 17000, 20000]],
])

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sameRecord = (first, second) => JSON.stringify(first ?? {}) === JSON.stringify(second ?? {})
const playerMoneyChanged = (previous, next, allowedPlayerIds = []) => {
  const allowed = new Set(allowedPlayerIds)
  const nextPlayers = new Map(next.players.map((player) => [player.id, player]))
  return previous.players.some((player) =>
    !allowed.has(player.id) && nextPlayers.get(player.id)?.money !== player.money)
}
const getMoneyDeltas = (previous, next) => {
  const nextPlayers = new Map(next.players.map((player) => [player.id, player]))
  return new Map(previous.players
    .map((player) => [player.id, nextPlayers.get(player.id)?.money - player.money])
    .filter(([, delta]) => delta !== 0))
}
const startBonusForLap = (lapNumber) => {
  if (lapNumber <= 30) return 2000
  if (lapNumber <= 35) return 1000
  if (lapNumber <= 40) return 500
  return 0
}
const changedPropertyState = (previous, next) =>
  !sameRecord(previous.owners, next.owners) ||
  !sameRecord(previous.propertyLevels, next.propertyLevels) ||
  !sameRecord(previous.mortgagedPropertyIds, next.mortgagedPropertyIds)

const liquidationValue = (previous, next, ownerId) => {
  let value = 0
  const previousMortgages = new Set(previous.mortgagedPropertyIds ?? [])
  const nextMortgages = new Set(next.mortgagedPropertyIds ?? [])
  for (const [tileId, group] of PROPERTY_GROUPS) {
    if (previous.owners?.[tileId] !== ownerId || next.owners?.[tileId] !== ownerId) continue
    const beforeLevel = previous.propertyLevels?.[tileId] ?? 0
    const afterLevel = next.propertyLevels?.[tileId] ?? 0
    if (afterLevel > beforeLevel) return null
    value += (beforeLevel - afterLevel) * Math.round(((GROUP_UPGRADE_COSTS.get(group) ?? 0) * 0.75) / 10) * 10
    if (!previousMortgages.has(tileId) && nextMortgages.has(tileId)) {
      if (afterLevel !== 0) return null
      value += Math.round(PROPERTY_PRICES.get(tileId) * 0.5)
    } else if (previousMortgages.has(tileId) !== nextMortgages.has(tileId)) {
      return null
    }
  }
  return value
}

const sameIds = (actualIds, expectedIds) => {
  if (actualIds.length !== expectedIds.length) return false
  return new Set(actualIds).size === actualIds.length &&
    expectedIds.every((id, index) => actualIds[index] === id)
}

export const validateGameState = (state, expectedPlayerIds) => {
  if (!isPlainObject(state) || !Array.isArray(state.players)) return 'invalid_state_shape'
  if (state.players.length < 2 || state.players.length > 5) return 'invalid_player_count'

  const playerIds = state.players.map((player) => player?.id)
  if (
    playerIds.some((id) => typeof id !== 'string' || !id) ||
    !sameIds(playerIds, expectedPlayerIds)
  ) return 'invalid_players'

  for (const player of state.players) {
    if (!Number.isSafeInteger(player.money) || player.money < 0) return 'invalid_player_money'
    if (!Number.isInteger(player.position) || player.position < 0 || player.position >= BOARD_SIZE) {
      return 'invalid_player_position'
    }
  }

  if (
    !Number.isInteger(state.activePlayerIndex) ||
    state.activePlayerIndex < 0 ||
    state.activePlayerIndex >= state.players.length
  ) return 'invalid_active_player'
  if (!Number.isSafeInteger(state.turnSequence) || state.turnSequence < 0) return 'invalid_turn_sequence'

  const playerIdSet = new Set(playerIds)
  if (!isPlainObject(state.owners) || !isPlainObject(state.propertyLevels)) return 'invalid_properties'
  for (const [rawTileId, ownerId] of Object.entries(state.owners)) {
    const tileId = Number(rawTileId)
    if (!Number.isInteger(tileId) || !BRAND_TILE_IDS.has(tileId) || !playerIdSet.has(ownerId)) {
      return 'invalid_property_owner'
    }
  }
  for (const [rawTileId, rawLevel] of Object.entries(state.propertyLevels)) {
    const tileId = Number(rawTileId)
    if (
      !BRAND_TILE_IDS.has(tileId) ||
      !Object.hasOwn(state.owners, rawTileId) ||
      !Number.isInteger(rawLevel) ||
      rawLevel < 0 ||
      rawLevel > MAX_PROPERTY_LEVEL
    ) return 'invalid_property_level'
  }

  if (!Array.isArray(state.mortgagedPropertyIds)) return 'invalid_mortgages'
  const mortgagedIds = new Set()
  for (const tileId of state.mortgagedPropertyIds) {
    if (
      !Number.isInteger(tileId) ||
      !BRAND_TILE_IDS.has(tileId) ||
      mortgagedIds.has(tileId) ||
      !Object.hasOwn(state.owners, tileId) ||
      (state.propertyLevels[tileId] ?? 0) !== 0
    ) return 'invalid_mortgages'
    mortgagedIds.add(tileId)
  }

  const eliminatedIds = state.eliminatedPlayerIds ?? []
  if (
    !Array.isArray(eliminatedIds) ||
    new Set(eliminatedIds).size !== eliminatedIds.length ||
    eliminatedIds.some((id) => !playerIdSet.has(id))
  ) return 'invalid_eliminated_players'
  if (state.winnerId != null && (!playerIdSet.has(state.winnerId) || eliminatedIds.includes(state.winnerId))) {
    return 'invalid_winner'
  }

  if (state.tradeDraft != null) {
    const trade = state.tradeDraft
    const activePlayerId = state.players[state.activePlayerIndex]?.id
    if (
      !isPlainObject(trade) ||
      !playerIdSet.has(trade.targetPlayerId) ||
      trade.targetPlayerId === activePlayerId ||
      !['draft', 'review'].includes(trade.stage) ||
      !Number.isSafeInteger(trade.offeredMoney) || trade.offeredMoney < 0 ||
      !Number.isSafeInteger(trade.requestedMoney) || trade.requestedMoney < 0 ||
      !Array.isArray(trade.offeredTileIds) || !Array.isArray(trade.requestedTileIds)
    ) return 'invalid_trade'
    const offeredIds = new Set(trade.offeredTileIds)
    const requestedIds = new Set(trade.requestedTileIds)
    if (
      offeredIds.size !== trade.offeredTileIds.length ||
      requestedIds.size !== trade.requestedTileIds.length ||
      [...offeredIds].some((tileId) => !BRAND_TILE_IDS.has(tileId) || state.owners[tileId] !== activePlayerId) ||
      [...requestedIds].some((tileId) => !BRAND_TILE_IDS.has(tileId) || state.owners[tileId] !== trade.targetPlayerId) ||
      [...offeredIds].some((tileId) => requestedIds.has(tileId))
    ) return 'invalid_trade_assets'
    const activePlayer = state.players.find((player) => player.id === activePlayerId)
    const targetPlayer = state.players.find((player) => player.id === trade.targetPlayerId)
    if (trade.offeredMoney > activePlayer.money || trade.requestedMoney > targetPlayer.money) {
      return 'invalid_trade_money'
    }
  }

  if (state.auction != null) {
    const auction = state.auction
    const participantIds = Array.isArray(auction.participantIds) ? auction.participantIds : []
    const passedIds = Array.isArray(auction.passedIds) ? auction.passedIds : []
    if (
      !isPlainObject(auction) ||
      !BRAND_TILE_IDS.has(auction.tileId) ||
      participantIds.length < 1 ||
      new Set(participantIds).size !== participantIds.length ||
      participantIds.some((id) => !playerIdSet.has(id) || eliminatedIds.includes(id)) ||
      !participantIds.includes(auction.activeBidderId) ||
      passedIds.includes(auction.activeBidderId) ||
      new Set(passedIds).size !== passedIds.length ||
      passedIds.some((id) => !participantIds.includes(id)) ||
      (auction.highestBidderId != null && !participantIds.includes(auction.highestBidderId)) ||
      !Number.isSafeInteger(auction.currentBid) ||
      auction.currentBid < PROPERTY_PRICES.get(auction.tileId)
    ) return 'invalid_auction'
  }

  if (state.pendingPayment != null) {
    const payment = state.pendingPayment
    if (
      !isPlainObject(payment) || !playerIdSet.has(payment.payerId) ||
      (payment.recipientId != null && (!playerIdSet.has(payment.recipientId) || payment.recipientId === payment.payerId)) ||
      !Number.isSafeInteger(payment.amount) || payment.amount <= 0 ||
      !Number.isInteger(payment.tileId) || payment.tileId < 0 || payment.tileId >= BOARD_SIZE ||
      !['rent', 'tax', 'event'].includes(payment.kind)
    ) return 'invalid_pending_payment'
  }
  if (!Array.isArray(state.eventPaymentQueue)) return 'invalid_event_payment_queue'
  for (const payment of state.eventPaymentQueue) {
    if (
      !isPlainObject(payment) || !playerIdSet.has(payment.payerId) ||
      (payment.recipientId != null && (!playerIdSet.has(payment.recipientId) || payment.recipientId === payment.payerId)) ||
      !Number.isSafeInteger(payment.amount) || payment.amount <= 0 ||
      !Number.isInteger(payment.tileId) || payment.tileId < 0 || payment.tileId >= BOARD_SIZE
    ) return 'invalid_event_payment_queue'
  }
  if (!Number.isSafeInteger(state.casinoJackpot) || state.casinoJackpot < INITIAL_CASINO_JACKPOT) {
    return 'invalid_casino_jackpot'
  }
  if (state.casino != null) {
    const casino = state.casino
    const selectedNumbers = Array.isArray(casino.selectedNumbers) ? casino.selectedNumbers : []
    if (
      !isPlainObject(casino) || !playerIdSet.has(casino.playerId) ||
      selectedNumbers.length > 3 || new Set(selectedNumbers).size !== selectedNumbers.length ||
      selectedNumbers.some((value) => !Number.isInteger(value) || value < 1 || value > 6) ||
      (casino.rolledNumber != null && (!Number.isInteger(casino.rolledNumber) || casino.rolledNumber < 1 || casino.rolledNumber > 6)) ||
      (casino.payout != null && (!Number.isSafeInteger(casino.payout) || casino.payout < 0)) ||
      (casino.jackpotWon != null && typeof casino.jackpotWon !== 'boolean')
    ) return 'invalid_casino'
  }

  return null
}

export const validateInitialGameState = (state) => {
  if (
    state.activePlayerIndex !== 0 || state.turnSequence !== 0 ||
    state.players.some((player) => player.money !== 15000 || player.position !== 0) ||
    Object.keys(state.owners ?? {}).length !== 0 || Object.keys(state.propertyLevels ?? {}).length !== 0 ||
    (state.mortgagedPropertyIds ?? []).length !== 0 || Object.keys(state.mortgageExpiryTurns ?? {}).length !== 0 ||
    state.pendingTileId != null || state.pendingPayment != null || state.auction != null ||
    state.tradeDraft != null || state.casino != null ||
    (state.eliminatedPlayerIds ?? []).length !== 0 || state.winnerId != null ||
    state.casinoJackpot !== INITIAL_CASINO_JACKPOT
  ) return 'invalid_initial_state'
  return null
}

export const validateTradeResolution = (previous, next, senderId) => {
  const trade = previous?.tradeDraft
  if (trade?.stage !== 'review' || next?.tradeDraft != null) return null
  if (senderId !== trade.targetPlayerId) return 'invalid_trade_responder'

  const previousPlayers = new Map(previous.players.map((player) => [player.id, player]))
  const nextPlayers = new Map(next.players.map((player) => [player.id, player]))
  const initiatorId = previous.players[previous.activePlayerIndex]?.id
  const initiatorDelta = trade.requestedMoney - trade.offeredMoney
  const targetDelta = -initiatorDelta
  const ownersChanged = !sameRecord(previous.owners, next.owners)
  const moneyChanged = previous.players.some((player) =>
    nextPlayers.get(player.id)?.money !== player.money)

  if (!ownersChanged && !moneyChanged) return null
  if (
    previousPlayers.get(initiatorId).money + initiatorDelta !== nextPlayers.get(initiatorId)?.money ||
    previousPlayers.get(trade.targetPlayerId).money + targetDelta !== nextPlayers.get(trade.targetPlayerId)?.money ||
    previous.players.some((player) =>
      ![initiatorId, trade.targetPlayerId].includes(player.id) &&
      nextPlayers.get(player.id)?.money !== player.money)
  ) return 'invalid_trade_balance'

  const expectedOwners = { ...previous.owners }
  for (const tileId of trade.offeredTileIds) expectedOwners[tileId] = trade.targetPlayerId
  for (const tileId of trade.requestedTileIds) expectedOwners[tileId] = initiatorId
  if (!sameRecord(expectedOwners, next.owners)) return 'invalid_trade_ownership'
  if (
    !sameRecord(previous.propertyLevels, next.propertyLevels) ||
    !sameRecord(previous.mortgagedPropertyIds, next.mortgagedPropertyIds) ||
    !sameRecord(previous.mortgageExpiryTurns, next.mortgageExpiryTurns)
  ) return 'invalid_trade_assets'

  return null
}

export const validatePurchaseTransition = (previous, next) => {
  const tileId = previous?.pendingTileId
  if (tileId == null || next?.pendingTileId != null || next?.auction != null) return null
  const actorId = previous.players[previous.activePlayerIndex]?.id
  const acquired = previous.owners?.[tileId] == null && next.owners?.[tileId] === actorId
  if (!acquired) return null
  const price = PROPERTY_PRICES.get(tileId)
  const previousPlayer = previous.players.find((player) => player.id === actorId)
  const nextPlayer = next.players.find((player) => player.id === actorId)
  if (!price || previousPlayer.money < price || nextPlayer?.money !== previousPlayer.money - price) {
    return 'invalid_purchase_balance'
  }
  const expectedOwners = { ...previous.owners, [tileId]: actorId }
  if (!sameRecord(expectedOwners, next.owners) || playerMoneyChanged(previous, next, [actorId])) {
    return 'invalid_purchase'
  }
  return null
}

export const validateAuctionTransition = (previous, next) => {
  const auction = previous?.auction
  if (!auction) {
    if (!next?.auction) return null
    const actorId = previous.players[previous.activePlayerIndex]?.id
    const tileId = previous.pendingTileId
    const startingPrice = PROPERTY_PRICES.get(tileId)
    const eliminatedIds = new Set(previous.eliminatedPlayerIds ?? [])
    const expectedParticipants = previous.players
      .filter((player) => player.id !== actorId && !eliminatedIds.has(player.id) &&
        player.money >= startingPrice + 100)
      .map((player) => player.id)
    if (
      next.auction.tileId !== tileId || previous.owners?.[tileId] != null ||
      !sameIds(next.auction.participantIds, expectedParticipants) ||
      next.auction.activeBidderId !== expectedParticipants[0] ||
      next.auction.currentBid !== startingPrice || next.auction.highestBidderId != null ||
      next.auction.passedIds.length !== 0
    ) return 'invalid_auction_creation'
    return null
  }
  const eliminatedIds = new Set(previous.eliminatedPlayerIds ?? [])
  const remainingBidderIds = auction.participantIds.filter((id) =>
    !auction.passedIds.includes(id) && !eliminatedIds.has(id))
  const isSoleAuctionDecision = auction.highestBidderId == null &&
    remainingBidderIds.length === 1 && remainingBidderIds[0] === auction.activeBidderId
  if (next.auction) {
    if (
      !sameRecord(previous.owners, next.owners) ||
      !sameRecord(previous.propertyLevels, next.propertyLevels) ||
      !sameRecord(previous.mortgagedPropertyIds, next.mortgagedPropertyIds) ||
      playerMoneyChanged(previous, next)
    ) return 'invalid_auction_side_effect'
    const bidderId = auction.activeBidderId
    const placedBid = next.auction.currentBid >= auction.currentBid + 100 &&
      next.auction.highestBidderId === bidderId
    const passed = next.auction.currentBid === auction.currentBid &&
      next.auction.passedIds.includes(bidderId)
    if (!placedBid && !passed) return 'invalid_auction_action'
    if (placedBid && isSoleAuctionDecision) return 'invalid_auction_action'
    const expectedPassedIds = passed ? [...new Set([...auction.passedIds, bidderId])] : auction.passedIds
    const expectedHighestBidder = placedBid ? bidderId : auction.highestBidderId
    const bidder = previous.players.find((player) => player.id === bidderId)
    if (
      next.auction.tileId !== auction.tileId ||
      JSON.stringify(next.auction.participantIds) !== JSON.stringify(auction.participantIds) ||
      !sameIds(next.auction.passedIds, expectedPassedIds) ||
      next.auction.highestBidderId !== expectedHighestBidder ||
      !Number.isSafeInteger(next.auction.currentBid) ||
      (placedBid && next.auction.currentBid > (bidder?.money ?? 0)) ||
      next.activePlayerIndex !== previous.activePlayerIndex ||
      next.turnSequence !== previous.turnSequence
    ) return 'invalid_auction_action'
    const candidates = auction.participantIds.filter((id) =>
      !expectedPassedIds.includes(id) && id !== expectedHighestBidder && !eliminatedIds.has(id) &&
      (previous.players.find((player) => player.id === id)?.money ?? 0) >= next.auction.currentBid + 100)
    const currentIndex = auction.participantIds.indexOf(bidderId)
    const orderedIds = [...auction.participantIds.slice(currentIndex + 1), ...auction.participantIds.slice(0, currentIndex + 1)]
    const expectedNextBidder = orderedIds.find((id) => candidates.includes(id))
    if (!expectedNextBidder || next.auction.activeBidderId !== expectedNextBidder) return 'invalid_auction_next_bidder'
    return null
  }

  const changedOwnerIds = [...new Set([
    ...Object.keys(previous.owners ?? {}),
    ...Object.keys(next.owners ?? {}),
  ])].filter((tileId) => previous.owners?.[tileId] !== next.owners?.[tileId])
  if (changedOwnerIds.length === 0) {
    if (playerMoneyChanged(previous, next)) return 'invalid_auction_balance'
    const remainingCandidates = auction.participantIds.filter((id) =>
      id !== auction.activeBidderId && !auction.passedIds.includes(id) && !eliminatedIds.has(id) &&
      (previous.players.find((player) => player.id === id)?.money ?? 0) >= auction.currentBid + 100)
    if (auction.highestBidderId != null || remainingCandidates.length > 0) return 'invalid_auction_completion'
    return null
  }
  if (changedOwnerIds.length !== 1 || Number(changedOwnerIds[0]) !== auction.tileId) {
    return 'invalid_auction_ownership'
  }
  const winnerId = next.owners[auction.tileId]
  const winner = previous.players.find((player) => player.id === winnerId)
  const nextWinner = next.players.find((player) => player.id === winnerId)
  if (!winner || !nextWinner || eliminatedIds.has(winnerId) || auction.passedIds.includes(winnerId)) return 'invalid_auction_ownership'
  const winsWithNewBid = winnerId === auction.activeBidderId
  const winningBid = winsWithNewBid
    ? winner.money - nextWinner.money
    : auction.currentBid
  if (
    !auction.participantIds.includes(winnerId) ||
    !Number.isSafeInteger(winningBid) ||
    winningBid < auction.currentBid ||
    (winsWithNewBid && winningBid < auction.currentBid + 100) ||
    (winsWithNewBid && isSoleAuctionDecision && winningBid !== auction.currentBid + 100) ||
    (!winsWithNewBid && winnerId !== auction.highestBidderId) ||
    nextWinner.money !== winner.money - winningBid ||
    playerMoneyChanged(previous, next, [winnerId])
  ) return 'invalid_auction_balance'
  const competingBidders = auction.participantIds.filter((id) =>
    id !== winnerId && (winsWithNewBid || id !== auction.activeBidderId) &&
    !auction.passedIds.includes(id) && !eliminatedIds.has(id) &&
    (previous.players.find((player) => player.id === id)?.money ?? 0) >= winningBid + 100)
  if (competingBidders.length > 0) return 'invalid_auction_completion'
  return null
}

export const validatePropertyTransition = (previous, next, senderId, mayHandleTimeout = false) => {
  const keys = (first, second) => [...new Set([
    ...Object.keys(first ?? {}).map(Number),
    ...Object.keys(second ?? {}).map(Number),
  ])]
  const ownerChanges = keys(previous.owners, next.owners)
    .filter((tileId) => previous.owners?.[tileId] !== next.owners?.[tileId])
  const levelChanges = keys(previous.propertyLevels, next.propertyLevels)
    .filter((tileId) => (previous.propertyLevels?.[tileId] ?? 0) !== (next.propertyLevels?.[tileId] ?? 0))
  const previousMortgages = new Set(previous.mortgagedPropertyIds ?? [])
  const nextMortgages = new Set(next.mortgagedPropertyIds ?? [])
  const mortgageChanges = [...new Set([...previousMortgages, ...nextMortgages])]
    .filter((tileId) => previousMortgages.has(tileId) !== nextMortgages.has(tileId))
  if (ownerChanges.length === 0 && levelChanges.length === 0 && mortgageChanges.length === 0) return null

  const specializedTransition = previous.tradeDraft?.stage === 'review' || previous.auction ||
    (previous.pendingTileId != null && previous.owners?.[previous.pendingTileId] == null &&
      next.owners?.[previous.pendingTileId] != null)
  if (specializedTransition) return null
  const newlyEliminated = (next.eliminatedPlayerIds ?? [])
    .some((id) => !(previous.eliminatedPlayerIds ?? []).includes(id))
  if (newlyEliminated) return null
  if (mayHandleTimeout && (previous.pendingPayment || (previous.jailedPlayerIds ?? []).includes(
    previous.players[previous.activePlayerIndex]?.id,
  ))) return null
  if (next.turnSequence !== previous.turnSequence) {
    if (next.turnSequence !== previous.turnSequence + 1) return 'invalid_property_turn'
    const expiredTileIds = new Set(Object.entries(previous.mortgageExpiryTurns ?? {})
      .filter(([, expiresAt]) => expiresAt <= next.turnSequence)
      .map(([tileId]) => Number(tileId)))
    const validExpiredOwners = ownerChanges.every((tileId) =>
      expiredTileIds.has(tileId) && previous.owners?.[tileId] != null && next.owners?.[tileId] == null)
    const validExpiredMortgages = mortgageChanges.every((tileId) =>
      expiredTileIds.has(tileId) && previousMortgages.has(tileId) && !nextMortgages.has(tileId))
    if (!validExpiredOwners || !validExpiredMortgages) return 'invalid_property_turn_transfer'
    const eventLevelChanges = levelChanges.filter((tileId) => !expiredTileIds.has(tileId))
    if (eventLevelChanges.length === 0) return null
    const actorId = previous.players[previous.activePlayerIndex]?.id
    const actorPosition = next.players.find((player) => player.id === actorId)?.position
    if (eventLevelChanges.length !== 1 || !DIAMOND_TILE_IDS.has(actorPosition)) {
      return 'invalid_property_event'
    }
    const tileId = eventLevelChanges[0]
    const beforeLevel = previous.propertyLevels?.[tileId] ?? 0
    const afterLevel = next.propertyLevels?.[tileId] ?? 0
    const group = PROPERTY_GROUPS.get(tileId)
    const groupTileIds = [...PROPERTY_GROUPS.entries()]
      .filter(([, candidateGroup]) => candidateGroup === group)
      .map(([candidateId]) => candidateId)
    const levels = groupTileIds.map((candidateId) => previous.propertyLevels?.[candidateId] ?? 0)
    const validAddition = afterLevel === beforeLevel + 1 && beforeLevel === Math.min(...levels)
    const validRemoval = afterLevel === beforeLevel - 1 && beforeLevel === Math.max(...levels)
    return previous.owners?.[tileId] === actorId && (validAddition || validRemoval)
      ? null
      : 'invalid_property_event_level'
  }
  if (ownerChanges.length > 0) return 'invalid_property_transfer'
  if (levelChanges.length + mortgageChanges.length !== 1) return 'invalid_property_operation'

  const actorId = previous.players[previous.activePlayerIndex]?.id
  if (senderId !== actorId) return 'invalid_property_actor'
  const previousPlayer = previous.players.find((player) => player.id === actorId)
  const nextPlayer = next.players.find((player) => player.id === actorId)
  if (!previousPlayer || !nextPlayer || playerMoneyChanged(previous, next, [actorId])) {
    return 'invalid_property_balance'
  }
  const moneyDelta = nextPlayer.money - previousPlayer.money

  if (levelChanges.length === 1) {
    const tileId = levelChanges[0]
    const beforeLevel = previous.propertyLevels?.[tileId] ?? 0
    const afterLevel = next.propertyLevels?.[tileId] ?? 0
    const group = PROPERTY_GROUPS.get(tileId)
    const upgradeCost = GROUP_UPGRADE_COSTS.get(group)
    if (!upgradeCost || previous.owners?.[tileId] !== actorId) return 'invalid_property_level_change'
    const groupTileIds = [...PROPERTY_GROUPS.entries()]
      .filter(([, candidateGroup]) => candidateGroup === group)
      .map(([candidateId]) => candidateId)
    const groupLevels = groupTileIds.map((candidateId) => previous.propertyLevels?.[candidateId] ?? 0)
    if (afterLevel === beforeLevel + 1) {
      const discount = Math.max(0, Number(previous.playerEffects?.[actorId]?.upgradeDiscount) || 0)
      const price = Math.max(50, upgradeCost - discount)
      const ownsGroup = groupTileIds.every((candidateId) => previous.owners?.[candidateId] === actorId)
      const groupMortgaged = groupTileIds.some((candidateId) => previousMortgages.has(candidateId))
      if (
        !ownsGroup || groupMortgaged || beforeLevel !== Math.min(...groupLevels) ||
        (previous.upgradedGroupsThisTurn ?? []).includes(group) || moneyDelta !== -price ||
        !(next.upgradedGroupsThisTurn ?? []).includes(group)
      ) return 'invalid_property_upgrade'
      if (discount > 0 && Number(next.playerEffects?.[actorId]?.upgradeDiscount) !== 0) {
        return 'invalid_upgrade_discount'
      }
      return null
    }
    const saleValue = Math.round((upgradeCost * 0.75) / 10) * 10
    if (afterLevel !== beforeLevel - 1 || beforeLevel !== Math.max(...groupLevels) || moneyDelta !== saleValue) {
      return 'invalid_star_sale'
    }
    return null
  }

  const tileId = mortgageChanges[0]
  const price = PROPERTY_PRICES.get(tileId)
  const group = PROPERTY_GROUPS.get(tileId)
  if (!price || previous.owners?.[tileId] !== actorId) return 'invalid_mortgage_owner'
  if (!previousMortgages.has(tileId) && nextMortgages.has(tileId)) {
    const groupHasStars = [...PROPERTY_GROUPS.entries()].some(([candidateId, candidateGroup]) =>
      candidateGroup === group && (previous.propertyLevels?.[candidateId] ?? 0) > 0)
    if (
      groupHasStars || moneyDelta !== Math.round(price * 0.5) ||
      next.mortgageExpiryTurns?.[tileId] !== previous.turnSequence + 15
    ) return 'invalid_mortgage'
    return null
  }
  if (
    previousMortgages.has(tileId) && !nextMortgages.has(tileId) &&
    moneyDelta === -Math.round(price * 0.6) &&
    next.mortgageExpiryTurns?.[tileId] == null
  ) return null
  return 'invalid_redemption'
}

export const validateMoneyTransition = (previous, next, senderId, movementAuthorization = null) => {
  const deltas = getMoneyDeltas(previous, next)
  if (deltas.size === 0) return null
  const actorId = previous.players[previous.activePlayerIndex]?.id
  const newlyEliminated = (next.eliminatedPlayerIds ?? [])
    .filter((id) => !(previous.eliminatedPlayerIds ?? []).includes(id))
  if (newlyEliminated.length > 0) {
    const expectedDeltas = new Map(newlyEliminated.map((playerId) => {
      const player = previous.players.find((item) => item.id === playerId)
      return [playerId, -(player?.money ?? 0)]
    }))
    const payment = previous.pendingPayment
    if (payment && newlyEliminated.includes(payment.payerId) && payment.recipientId) {
      const payer = previous.players.find((player) => player.id === payment.payerId)
      const transferred = Math.min(payer?.money ?? 0, payment.amount)
      expectedDeltas.set(payment.recipientId, (expectedDeltas.get(payment.recipientId) ?? 0) + transferred)
    }
    for (const [playerId, delta] of [...expectedDeltas]) {
      if (delta === 0) expectedDeltas.delete(playerId)
    }
    const valid = expectedDeltas.size === deltas.size &&
      [...expectedDeltas].every(([playerId, delta]) => deltas.get(playerId) === delta)
    return valid ? null : 'invalid_elimination_balance'
  }

  const purchaseTileId = previous.pendingTileId
  const isPurchase = purchaseTileId != null && next.pendingTileId == null &&
    previous.owners?.[purchaseTileId] == null && next.owners?.[purchaseTileId] === actorId
  const isAuction = Boolean(previous.auction)
  const isTrade = previous.tradeDraft?.stage === 'review' && next.tradeDraft == null &&
    (changedPropertyState(previous, next) || deltas.size > 0)
  const isManualPropertyOperation = previous.turnSequence === next.turnSequence &&
    !isPurchase && !isAuction && !isTrade && changedPropertyState(previous, next)
  if (isPurchase || isAuction || isTrade || isManualPropertyOperation) return null

  const payment = previous.pendingPayment
  if (payment && previous.players.some((player) => player.id === payment.payerId)) {
    const payer = previous.players.find((player) => player.id === payment.payerId)
    const raised = changedPropertyState(previous, next)
      ? liquidationValue(previous, next, payment.payerId)
      : 0
    if (raised == null) return 'invalid_payment_liquidation'
    const expectedPayerDelta = raised - payment.amount
    if (payer.money + expectedPayerDelta < 0 || deltas.get(payment.payerId) !== expectedPayerDelta) {
      return 'invalid_payment_balance'
    }
    if (payment.recipientId && deltas.get(payment.recipientId) !== payment.amount) {
      return 'invalid_payment_recipient'
    }
    const allowedIds = new Set([payment.payerId, payment.recipientId].filter(Boolean))
    return [...deltas.keys()].every((playerId) => allowedIds.has(playerId))
      ? null
      : 'invalid_payment_participants'
  }

  const actorWasJailed = (previous.jailedPlayerIds ?? []).includes(actorId)
  const actorStillJailed = (next.jailedPlayerIds ?? []).includes(actorId)
  if (actorWasJailed && !actorStillJailed) {
    const freeRelease = Boolean(previous.playerEffects?.[actorId]?.freeJailRelease)
    const raised = changedPropertyState(previous, next) ? liquidationValue(previous, next, actorId) : 0
    const expectedDelta = freeRelease ? 0 : (raised ?? 0) - JAIL_RELEASE_COST
    return raised != null && deltas.size === 1 && deltas.get(actorId) === expectedDelta
      ? null
      : 'invalid_jail_payment'
  }

  const previousCasino = previous.casino
  const nextCasino = next.casino
  if (previousCasino && previousCasino.rolledNumber == null && nextCasino?.rolledNumber != null) {
    const selectedNumbers = previousCasino.selectedNumbers ?? []
    const rolledNumber = nextCasino.rolledNumber
    const guessed = selectedNumbers.includes(rolledNumber)
    const regularPayout = guessed ? Math.round(CASINO_BET * (6 / selectedNumbers.length)) : 0
    const jackpotWon = Boolean(nextCasino.jackpotWon)
    const payout = regularPayout + (jackpotWon ? previous.casinoJackpot : 0)
    const validJackpot = jackpotWon
      ? next.casinoJackpot === INITIAL_CASINO_JACKPOT
      : next.casinoJackpot === previous.casinoJackpot + CASINO_JACKPOT_STEP
    if (
      senderId !== previousCasino.playerId ||
      !Number.isInteger(rolledNumber) || rolledNumber < 1 || rolledNumber > 6 ||
      selectedNumbers.length < 1 || selectedNumbers.length > 3 ||
      nextCasino.payout !== payout || !validJackpot ||
      deltas.size !== 1 || deltas.get(previousCasino.playerId) !== payout - CASINO_BET
    ) return 'invalid_casino_balance'
    return null
  }

  const actorDelta = deltas.get(actorId)
  if (deltas.size === 1 && actorDelta > 0) {
    const lapNumber = next.lapCounts?.[actorId] ?? 0
    const rewardKeys = new Set(previous.serverEconomy?.rewardKeys ?? [])
    const startRewardKey = `start:${actorId}:${lapNumber}`
    const pendingBookBonusKeys = new Set(previous.serverEconomy?.pendingBookBonusKeys ?? [])
    const pendingBookBonusAmounts = { ...(previous.serverEconomy?.pendingBookBonusAmounts ?? {}) }
    const bookBonus = bookBonusAmount(previous.playerEffects?.[actorId]?.bookChallenge)
      || pendingBookBonusAmounts[startRewardKey]
      || (pendingBookBonusKeys.has(startRewardKey) ? BOOK_BONUS_AMOUNT : 0)
    const startReward = startBonusForLap(lapNumber) + bookBonus
    if (
      movementAuthorization?.playerId === actorId && movementAuthorization.passedStart &&
      movementAuthorization.destination === next.players.find((player) => player.id === actorId)?.position &&
      movementAuthorization.lapNumber === lapNumber &&
      actorDelta === startReward && !rewardKeys.has(startRewardKey)
    ) {
      pendingBookBonusKeys.delete(startRewardKey)
      // The client can clear the effect before its animated money update arrives.
      const nextPendingAmounts = { ...(next.serverEconomy?.pendingBookBonusAmounts ?? pendingBookBonusAmounts) }
      delete nextPendingAmounts[startRewardKey]
      next.serverEconomy = {
        ...next.serverEconomy,
        rewardKeys: [...rewardKeys, startRewardKey].slice(-200),
        pendingBookBonusKeys: [...pendingBookBonusKeys],
        pendingBookBonusAmounts: nextPendingAmounts,
      }
      return null
    }

    const position = next.players.find((player) => player.id === actorId)?.position
    const eventRewardKey = `event:${actorId}:${previous.turnSequence}`
    const validChanceReward = CHANCE_TILE_IDS.has(position) &&
      (actorDelta === 250 || (actorDelta >= 200 && actorDelta <= 800 && actorDelta % 10 === 0))
    const validDiamondReward = DIAMOND_TILE_IDS.has(position) && [250, 500, 750, 1000].includes(actorDelta)
    if ((validChanceReward || validDiamondReward) && !rewardKeys.has(eventRewardKey)) {
      next.serverEconomy = { ...next.serverEconomy, rewardKeys: [...rewardKeys, eventRewardKey].slice(-200) }
      return null
    }
  }

  if (CHANCE_TILE_IDS.has(next.players.find((player) => player.id === actorId)?.position)) {
    for (const contribution of [100, 300]) {
      const expected = new Map()
      let received = 0
      for (const player of previous.players) {
        if (player.id === actorId || (previous.eliminatedPlayerIds ?? []).includes(player.id)) continue
        const amount = Math.min(contribution, player.money)
        if (amount > 0) expected.set(player.id, -amount)
        received += amount
      }
      if (received > 0) expected.set(actorId, received)
      if (expected.size === deltas.size && [...expected].every(([id, delta]) => deltas.get(id) === delta)) {
        const rewardKeys = new Set(previous.serverEconomy?.rewardKeys ?? [])
        const eventRewardKey = `event:${actorId}:${previous.turnSequence}`
        if (rewardKeys.has(eventRewardKey)) return 'duplicate_event_reward'
        next.serverEconomy = { ...next.serverEconomy, rewardKeys: [...rewardKeys, eventRewardKey].slice(-200) }
        return null
      }
    }
  }

  return 'unexplained_money_change'
}

export const validatePendingPaymentTransition = (previous, next) => {
  if (previous.pendingPayment || !next.pendingPayment) return null
  const payment = next.pendingPayment
  const actorId = previous.players[previous.activePlayerIndex]?.id
  const actor = next.players.find((player) => player.id === actorId)
  if (!actor || payment.payerId !== actorId || actor.position !== payment.tileId) {
    return 'invalid_payment_actor'
  }
  if (next.eventPaymentQueue.length !== 0) return 'invalid_event_payment_queue_creation'

  if (payment.kind === 'rent') {
    const ownerId = next.owners?.[payment.tileId]
    if (
      ownerId == null || ownerId === actorId || payment.recipientId !== ownerId ||
      (next.mortgagedPropertyIds ?? []).includes(payment.tileId)
    ) return 'invalid_rent_recipient'
    let baseRent = 0
    if (SUBSCRIPTION_TILE_IDS.has(payment.tileId)) {
      const ownedCount = [...SUBSCRIPTION_TILE_IDS].filter((tileId) => next.owners?.[tileId] === ownerId).length
      const multiplier = ownedCount >= 2 ? 250 : 100
      const dice = next.lastRoll?.dice
      if (!Array.isArray(dice) || dice.length !== 2) return 'invalid_rent_roll'
      baseRent = (dice[0] + dice[1]) * multiplier
    } else if (FLEET_TILE_IDS.has(payment.tileId)) {
      const ownedCount = [...FLEET_TILE_IDS].filter((tileId) => next.owners?.[tileId] === ownerId).length
      baseRent = [250, 500, 1000, 2000][Math.max(0, Math.min(3, ownedCount - 1))]
    } else {
      const rents = PROPERTY_RENTS.get(payment.tileId)
      baseRent = rents?.[next.propertyLevels?.[payment.tileId] ?? 0] ?? 0
    }
    const payerAdjustment = previous.playerEffects?.[actorId]?.nextRentAdjustment ?? 0
    const ownerAdjustment = previous.playerEffects?.[ownerId]?.nextVisitorAdjustment ?? 0
    return payment.amount === Math.max(0, baseRent + payerAdjustment + ownerAdjustment)
      ? null
      : 'invalid_rent_amount'
  }

  if (payment.kind === 'tax') {
    if (!TAX_TILE_IDS.has(payment.tileId) || payment.recipientId != null) return 'invalid_tax_payment'
    const ownedTiles = [...PROPERTY_PRICES.keys()].filter((tileId) => next.owners?.[tileId] === actorId)
    const smallStars = ownedTiles.reduce((total, tileId) => {
      const level = next.propertyLevels?.[tileId] ?? 0
      return total + (level === MAX_PROPERTY_LEVEL ? 0 : level)
    }, 0)
    const allStars = ownedTiles.filter((tileId) => (next.propertyLevels?.[tileId] ?? 0) === MAX_PROPERTY_LEVEL).length
    const allowedAmounts = new Set([
      ownedTiles.length * 100,
      smallStars * 250 + allStars * 1000,
    ])
    const isRegularTax = payment.amount >= 100 && payment.amount <= 700 && payment.amount % 10 === 0
    return isRegularTax || allowedAmounts.has(payment.amount) ? null : 'invalid_tax_amount'
  }

  if (payment.kind === 'event') {
    const isChance = CHANCE_TILE_IDS.has(payment.tileId)
    const isDiamond = DIAMOND_TILE_IDS.has(payment.tileId)
    if (!isChance && !isDiamond) return 'invalid_event_payment'
    if (payment.recipientId != null) {
      return isChance && payment.amount === 100 ? null : 'invalid_event_transfer'
    }
    const validChanceCharge = isChance && payment.amount >= 100 && payment.amount <= 990 && payment.amount % 10 === 0
    const validDiamondCharge = isDiamond && [250, 500, 750, 1000].includes(payment.amount)
    return validChanceCharge || validDiamondCharge ? null : 'invalid_event_amount'
  }
  return 'invalid_payment_kind'
}

export const validatePendingTileTransition = (previous, next) => {
  if (previous.pendingTileId != null || next.pendingTileId == null) return null
  const actorId = previous.players[previous.activePlayerIndex]?.id
  const actor = next.players.find((player) => player.id === actorId)
  const tileId = next.pendingTileId
  if (
    !BRAND_TILE_IDS.has(tileId) || actor?.position !== tileId || next.owners?.[tileId] != null ||
    next.pendingPayment != null || next.auction != null || next.casino != null || next.tradeDraft != null
  ) return 'invalid_purchase_decision'
  return null
}

export const validateCasinoTransition = (previous, next) => {
  if (previous.casino || !next.casino) return null
  const actorId = previous.players[previous.activePlayerIndex]?.id
  const actor = next.players.find((player) => player.id === actorId)
  if (
    actor?.position !== 20 || next.casino.playerId !== actorId ||
    next.casino.selectedNumbers.length !== 0 || next.casino.rolledNumber != null ||
    next.casino.payout != null || next.casino.jackpotWon != null ||
    next.casinoJackpot !== previous.casinoJackpot
  ) return 'invalid_casino_creation'
  return null
}
