export const BOOK_BONUS_AMOUNT = 1000

// Older saved games store a boolean instead of the number of active challenges.
export const bookChallengeCount = (value) => value === true
  ? 1
  : Number.isSafeInteger(value) && value > 0 ? value : 0

export const bookBonusAmount = (value) => bookChallengeCount(value) * BOOK_BONUS_AMOUNT

export const preservePendingBookBonuses = (previous, next) => {
  const amounts = { ...(previous.serverEconomy?.pendingBookBonusAmounts ?? {}) }
  for (const key of previous.serverEconomy?.pendingBookBonusKeys ?? []) {
    if (!(key in amounts)) amounts[key] = BOOK_BONUS_AMOUNT
  }
  for (const player of previous.players) {
    const previousLap = previous.lapCounts?.[player.id] ?? 0
    const nextLap = next.lapCounts?.[player.id] ?? 0
    const amount = bookBonusAmount(previous.playerEffects?.[player.id]?.bookChallenge)
    if (amount > 0 && !next.playerEffects?.[player.id]?.bookChallenge && nextLap > previousLap) {
      amounts[`start:${player.id}:${nextLap}`] = amount
    }
  }
  return Object.fromEntries(Object.entries(amounts).slice(-50))
}
