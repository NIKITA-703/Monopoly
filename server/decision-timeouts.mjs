// These decisions need no randomness or animation and can finish on the server,
// even when every browser is hidden or disconnected.
export const resolveDecisionTimeout = (previous, tileNames = []) => {
  if (!previous.tradeDraft && !previous.auction) return null
  const state = structuredClone(previous)
  const events = []
  if (state.tradeDraft) {
    events.push({ playerId: state.tradeDraft.targetPlayerId, kind: 'trade', text: 'Время обмена истекло — предложение закрыто' })
    state.tradeDraft = null
    return { state, events }
  }

  const auction = state.auction
  const tileName = tileNames[auction.tileId] ?? `поле №${auction.tileId}`
  const bidder = state.players.find((player) => player.id === auction.activeBidderId)
  auction.passedIds = [...new Set([...auction.passedIds, auction.activeBidderId])]
  events.push({ playerId: bidder?.id, kind: 'auction', text: `${bidder?.name ?? 'Игрок'} не отвечает вовремя и пасует на аукционе за ${tileName}` })
  const eligible = auction.participantIds.filter((id) =>
    !auction.passedIds.includes(id) && id !== auction.highestBidderId &&
    !state.eliminatedPlayerIds?.includes(id) &&
    (state.players.find((player) => player.id === id)?.money ?? 0) >= auction.currentBid + 100)
  if (eligible.length > 0) {
    const index = auction.participantIds.indexOf(auction.activeBidderId)
    const ordered = [...auction.participantIds.slice(index + 1), ...auction.participantIds.slice(0, index + 1)]
    auction.activeBidderId = ordered.find((id) => eligible.includes(id))
    return { state, events }
  }

  const winner = state.players.find((player) => player.id === auction.highestBidderId)
  if (winner) {
    winner.money -= auction.currentBid
    winner.lastDelta = -auction.currentBid
    state.owners[auction.tileId] = winner.id
    if (state.playerEffects?.[winner.id]?.bookChallenge) state.playerEffects[winner.id].bookChallenge = false
    events.push({ playerId: winner.id, kind: 'auction', amount: -auction.currentBid,
      text: `${winner.name} выигрывает аукцион за ${tileName}: $${auction.currentBid.toLocaleString('ru-RU')}k` })
  } else {
    events.push({ kind: 'auction', text: `Аукцион за ${tileName} завершён без покупателя` })
  }
  state.auction = null
  state.pendingTileId = null
  state.upgradedGroupsThisTurn = []
  if (state.hasExtraRoll) {
    state.hasExtraRoll = false
    return { state, events }
  }

  state.turnSequence += 1
  state.tradeRequestsThisTurn = 0
  for (const [tileId, expiresAt] of Object.entries(state.mortgageExpiryTurns ?? {})) {
    if (expiresAt > state.turnSequence) continue
    delete state.owners[tileId]
    delete state.propertyLevels[tileId]
    delete state.mortgageExpiryTurns[tileId]
    state.mortgagedPropertyIds = state.mortgagedPropertyIds.filter((id) => id !== Number(tileId))
    events.push({ kind: 'mortgage', text: `Срок выкупа поля №${tileId} истёк — поле возвращается банку` })
  }
  for (let checked = 0; checked < state.players.length; checked += 1) {
    state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length
    const player = state.players[state.activePlayerIndex]
    if (state.eliminatedPlayerIds?.includes(player.id)) continue
    const effect = state.playerEffects?.[player.id]
    if (!(effect?.skipTurns > 0)) break
    effect.skipTurns -= 1
    events.push({ playerId: player.id, kind: 'chance', text: `${player.name} пропускает ход` })
  }
  return { state, events }
}
