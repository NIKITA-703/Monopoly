const BOARD_SIZE = 40
const MAX_PROPERTY_LEVEL = 5
const BRAND_TILE_IDS = new Set([
  1, 3, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19,
  21, 23, 24, 25, 26, 27, 28, 29, 31, 32, 34, 35, 37, 39,
])

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

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

  return null
}
