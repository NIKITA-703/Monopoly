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

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sameRecord = (first, second) => JSON.stringify(first ?? {}) === JSON.stringify(second ?? {})
const playerMoneyChanged = (previous, next, allowedPlayerIds = []) => {
  const allowed = new Set(allowedPlayerIds)
  const nextPlayers = new Map(next.players.map((player) => [player.id, player]))
  return previous.players.some((player) =>
    !allowed.has(player.id) && nextPlayers.get(player.id)?.money !== player.money)
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
  if (!auction) return null
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
    return null
  }

  const changedOwnerIds = [...new Set([
    ...Object.keys(previous.owners ?? {}),
    ...Object.keys(next.owners ?? {}),
  ])].filter((tileId) => previous.owners?.[tileId] !== next.owners?.[tileId])
  if (changedOwnerIds.length === 0) {
    if (playerMoneyChanged(previous, next)) return 'invalid_auction_balance'
    return null
  }
  if (changedOwnerIds.length !== 1 || Number(changedOwnerIds[0]) !== auction.tileId) {
    return 'invalid_auction_ownership'
  }
  const winnerId = next.owners[auction.tileId]
  const winner = previous.players.find((player) => player.id === winnerId)
  const nextWinner = next.players.find((player) => player.id === winnerId)
  const winsWithNewBid = winnerId === auction.activeBidderId
  const winningBid = winsWithNewBid
    ? winner.money - nextWinner.money
    : auction.currentBid
  if (
    !auction.participantIds.includes(winnerId) ||
    !Number.isSafeInteger(winningBid) ||
    winningBid < auction.currentBid ||
    (winsWithNewBid && winningBid < auction.currentBid + 100) ||
    (!winsWithNewBid && winnerId !== auction.highestBidderId) ||
    nextWinner.money !== winner.money - winningBid ||
    playerMoneyChanged(previous, next, [winnerId])
  ) return 'invalid_auction_balance'
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
  if (newlyEliminated || mayHandleTimeout || next.turnSequence !== previous.turnSequence) return null
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
