import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import './App.css'
import { playGameSound, unlockGameAudio } from './audio/gameAudio'
import DiceRollAnimation, {
  diceRollAnimationDuration,
  diceRollAnimationEnabled,
} from './components/DiceRollAnimation'
import { eventImages, groupColors, groupLabels, initialPlayers as defaultPlayers, tiles } from './gameData'
import { randomIntInclusive, rollComplexDice } from './random/randomEngine'
import type { DiceRoll, LogEntry, Player, Tile, TradeLogDetails } from './types'
import type { OnlineGameEvent } from './online/types'

const casinoBet = 1000
const initialCasinoJackpot = 2000
const casinoJackpotStep = 250
const jailReleaseCost = 500
const auctionIncrement = 100
const maxPropertyLevel = 5
const rentMultipliers = [1, 2, 3, 5, 7, 10]
const subscriptionRentMultipliers = [100, 250]
const fleetRentLevels = [250, 500, 1000, 2000]
const groupUpgradeCosts: Record<string, number> = {
  fashion: 500,
  sportswear: 500,
  gaming: 750,
  'big-tech': 1000,
  ai: 1250,
  creators: 1500,
  social: 1750,
  space: 2000,
}
const gameSceneWidth = 1704
const gameSceneHeight = 1240
const fullHdGameSceneHeight = 1140
const movementPixelsPerMillisecond = 0.53
const fallbackMovementDurationPerTile = 220
const movementTokenRadius = 23
const maxTradeRequestsPerTurn = 3
const startBonusForLap = (lapNumber: number) => {
  if (lapNumber <= 30) return 2000
  if (lapNumber <= 35) return 1000
  if (lapNumber <= 40) return 500
  return 0
}
type AuctionState = {
  tileId: number
  participantIds: string[]
  activeBidderId: string
  currentBid: number
  highestBidderId: string | null
  passedIds: string[]
}

type TradeDraft = {
  targetPlayerId: string
  offeredMoney: number
  requestedMoney: number
  offeredTileIds: number[]
  requestedTileIds: number[]
  stage: 'draft' | 'review'
}

type PendingPayment = {
  payerId: string
  recipientId?: string
  tileId: number
  amount: number
  kind: 'rent' | 'tax' | 'event'
  eventLabel?: string
}

type PlayerEffects = {
  nextRentAdjustment?: number
  nextVisitorAdjustment?: number
  upgradeDiscount?: number
  freeJailRelease?: boolean
  reverseNextRoll?: boolean
  skipTurns?: number
  bookChallenge?: boolean
}

type EventPayment = {
  payerId: string
  recipientId?: string
  amount: number
  tileId: number
  label: string
}

export type OnlineGameState = {
  players: Player[]
  activePlayerIndex: number
  owners: Record<number, string>
  propertyLevels: Record<number, number>
  mortgagedPropertyIds: number[]
  mortgageExpiryTurns: Record<number, number>
  turnSequence: number
  logs: LogEntry[]
  lastRoll: DiceRoll | null
  pendingTileId: number | null
  tradeDraft: TradeDraft | null
  auction: AuctionState | null
  pendingPayment: PendingPayment | null
  eventPaymentQueue: EventPayment[]
  hasExtraRoll: boolean
  jailedPlayerIds: string[]
  jailFailedAttempts: Record<string, number>
  casino: CasinoState | null
  casinoJackpot: number
  upgradedGroupsThisTurn: string[]
  playerEffects: Record<string, PlayerEffects>
  lapCounts: Record<string, number>
  tradeRequestsThisTurn: number
  missedTurnCounts: Record<string, number>
  eliminatedPlayerIds: string[]
  winnerId: string | null
}

type CasinoState = {
  playerId: string
  selectedNumbers: number[]
  rolledNumber?: number
  payout?: number
  jackpotWon?: boolean
}

function GameViewport({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  const readabilityBoost = Math.min(1.32, Math.max(1, 0.92 / scale))
  const tileReadabilityBoost = Math.min(1.12, Math.max(1, 0.8 / scale))

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const updateScale = () => {
      const sceneHeight = viewport.clientHeight <= 1100 ? fullHdGameSceneHeight : gameSceneHeight
      const nextScale = Math.min(
        (viewport.clientWidth - 32) / gameSceneWidth,
        (viewport.clientHeight - 32) / sceneHeight,
      )

      setScale(Math.max(0.1, nextScale))
    }

    updateScale()
    const observer = new ResizeObserver(updateScale)
    observer.observe(viewport)

    return () => observer.disconnect()
  }, [])

  return (
    <main className="game-viewport" ref={viewportRef}>
      <div
        className="game-shell"
        style={{
          '--game-scale': scale,
          '--readability-boost': readabilityBoost,
          '--tile-readability-boost': tileReadabilityBoost,
        } as CSSProperties}
      >
        {children}
      </div>
    </main>
  )
}

const tilePosition = (index: number) => {
  if (index <= 10) {
    return { gridRow: 1, gridColumn: index + 1 }
  }

  if (index <= 20) {
    return { gridRow: index - 9, gridColumn: 11 }
  }

  if (index <= 30) {
    return { gridRow: 11, gridColumn: 31 - index }
  }

  return { gridRow: 41 - index, gridColumn: 1 }
}

const getTileSide = (index: number) => {
  if ([0, 10, 20, 30].includes(index)) return 'corner'
  if (index < 10) return 'top'
  if (index < 20) return 'right'
  if (index < 30) return 'bottom'
  return 'left'
}

const getPropertyDialogAxis = (index: number) => {
  if (index < 10) return ((index - 0.5) / 9) * 100
  if (index < 20) return ((index - 10.5) / 9) * 100
  if (index < 30) return ((29.5 - index) / 9) * 100
  return ((39.5 - index) / 9) * 100
}

const moneyFormatter = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 0,
})

const money = (value: number) => `$${moneyFormatter.format(Math.abs(value))}k`

const deltaMoney = (value = 0) => {
  if (value > 0) return `+${money(value)}`
  if (value < 0) return `-${money(value)}`
  return money(0)
}

const brandTiles = tiles.filter((tile) => tile.type === 'brand')
const subscriptionTiles = brandTiles.filter(isSubscriptionTile)
const fleetTiles = brandTiles.filter(isFleetTile)
const brandTilesByName = new Map(brandTiles.map((tile) => [tile.name.toLocaleLowerCase('ru-RU'), tile]))
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const eventHighlightBaseTokens = ['Шанс', 'Алмазик', ...brandTiles.map((tile) => tile.name)]
const minimalistChatStorageKey = 'monopoly:minimalist-chat'

const readMinimalistChatPreference = () => {
  try {
    return window.localStorage.getItem(minimalistChatStorageKey) === 'enabled'
  } catch {
    return false
  }
}

const createLog = (
  text: string,
  playerId?: string,
  kind: LogEntry['kind'] = 'system',
  amount?: number,
  tradeDetails?: TradeLogDetails,
): LogEntry => ({
  id: crypto.randomUUID(),
  playerId,
  text,
  kind,
  amount,
  tradeDetails,
  time: new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date()),
})

const shortTradeBundle = (assetNames: string[], amount: number) => {
  const parts = assetNames.slice(0, 2)
  if (assetNames.length > 2) parts.push(`ещё ${assetNames.length - 2}`)
  if (amount > 0) parts.push(money(amount))
  return parts.length > 0 ? parts.join(', ') : 'ничего'
}

const getTileTone = (tile: Tile) => {
  if (tile.type === 'chance') return '#8a58cc'
  if (tile.type === 'diamond') return '#7d8794'
  if (tile.type === 'casino') return '#e2ad1f'
  if (tile.type === 'jail') return '#8a58cc'
  if (tile.type === 'tax') return '#d84252'
  if (tile.type === 'police') return '#2f75c9'
  if (tile.type === 'start') return '#d84252'
  if (tile.type === 'brand' && tile.group) return groupColors[tile.group]
  return '#6f7786'
}

const getRentAtLevel = (tile: Tile, level = 0) => {
  const safeLevel = Math.max(0, Math.min(maxPropertyLevel, level))
  if (tile.rentLevels?.[safeLevel] !== undefined) return tile.rentLevels[safeLevel]
  return Math.round((tile.rent ?? 0) * rentMultipliers[safeLevel])
}

function isSubscriptionTile(tile: Tile) {
  return tile.rentMode === 'dice-multiplier'
}

function isFleetTile(tile: Tile) {
  return tile.rentMode === 'fleet-multiplier'
}

function isUpgradeableTile(tile: Tile) {
  return tile.rentMode === undefined
}

const dicePips: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

function CasinoDie({ value, selected = false }: { value: number; selected?: boolean }) {
  return (
    <span className={`casino-die ${selected ? 'selected' : ''}`} aria-label={`${value}`}>
      {dicePips[value].map((position) => (
        <i className={`pip pip-${position}`} key={position} />
      ))}
    </span>
  )
}

const getUpgradeCost = (tile: Tile) => groupUpgradeCosts[tile.group ?? ''] ?? 0
const getMortgageValue = (tile: Tile) => Math.round((tile.price ?? 0) * 0.5)
const getRedemptionCost = (tile: Tile) => Math.round((tile.price ?? 0) * 0.6)
const getStarSaleValue = (tile: Tile) => Math.round((getUpgradeCost(tile) * 0.75) / 10) * 10

const canMortgageProperty = (tile: Tile, levels: Record<number, number>) => {
  if ((levels[tile.id] ?? 0) > 0) return false
  if (!tile.group) return true
  return brandTiles
    .filter((candidate) => candidate.group === tile.group)
    .every((candidate) => (levels[candidate.id] ?? 0) === 0)
}

const canUpgradePropertyEvenly = (tile: Tile, levels: Record<number, number>) => {
  if (!tile.group) return false
  const groupLevels = brandTiles
    .filter((item) => item.group === tile.group)
    .map((item) => levels[item.id] ?? 0)

  return (levels[tile.id] ?? 0) === Math.min(...groupLevels)
}

const canSellPropertyStarEvenly = (tile: Tile, levels: Record<number, number>) => {
  if (!tile.group) return true
  const groupLevels = brandTiles
    .filter((item) => item.group === tile.group)
    .map((item) => levels[item.id] ?? 0)

  return (levels[tile.id] ?? 0) === Math.max(...groupLevels)
}

const nextParticipant = (participantIds: string[], currentId: string, candidates: string[]) => {
  const currentIndex = participantIds.indexOf(currentId)

  for (let offset = 1; offset <= participantIds.length; offset += 1) {
    const id = participantIds[(currentIndex + offset) % participantIds.length]
    if (candidates.includes(id)) return id
  }

  return candidates[0]
}

type MovementPoint = { x: number; y: number }

const distanceBetween = (first: MovementPoint, second: MovementPoint) =>
  Math.hypot(second.x - first.x, second.y - first.y)

const smoothMovementPath = (points: MovementPoint[]) => {
  if (points.length < 3) return points
  const smoothed: MovementPoint[] = [points[0]]

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    const incoming = { x: current.x - previous.x, y: current.y - previous.y }
    const outgoing = { x: next.x - current.x, y: next.y - current.y }
    const cross = incoming.x * outgoing.y - incoming.y * outgoing.x

    if (Math.abs(cross) < 1) {
      smoothed.push(current)
      continue
    }

    const incomingLength = distanceBetween(previous, current)
    const outgoingLength = distanceBetween(current, next)
    const radius = Math.min(34, incomingLength * 0.28, outgoingLength * 0.28)
    const before = {
      x: current.x - (incoming.x / incomingLength) * radius,
      y: current.y - (incoming.y / incomingLength) * radius,
    }
    const after = {
      x: current.x + (outgoing.x / outgoingLength) * radius,
      y: current.y + (outgoing.y / outgoingLength) * radius,
    }

    smoothed.push(before)
    for (const progress of [0.2, 0.4, 0.6, 0.8, 1]) {
      const inverse = 1 - progress
      smoothed.push({
        x: inverse * inverse * before.x + 2 * inverse * progress * current.x + progress * progress * after.x,
        y: inverse * inverse * before.y + 2 * inverse * progress * current.y + progress * progress * after.y,
      })
    }
  }

  smoothed.push(points.at(-1) as MovementPoint)
  return smoothed
}

const pickRandom = <T,>(items: readonly T[]) => items[randomIntInclusive(0, items.length - 1)]
const randomMoneyByTen = (minimum: number, maximum: number) =>
  randomIntInclusive(Math.ceil(minimum / 10), Math.floor(maximum / 10)) * 10

type AppProps = {
  initialGamePlayers?: Player[]
  localPlayerId?: string
  onlineState?: { revision: number; state: OnlineGameState } | null
  publishOnlineState?: (state: OnlineGameState) => void
  beginOnlineTurnAction?: () => void
  turnDeadline?: number | null
  turnTimeoutSignal?: { timeoutId: string; actorId: string | null } | null
  onReturnToLobby?: () => void
  sendOnlineChat?: (text: string) => void
  disconnectedPlayerIds?: string[]
  onlineGameEvent?: { nonce: string; senderId: string; event: OnlineGameEvent } | null
  acknowledgeOnlineGameEvent?: (eventId: string) => void
  sendOnlineGameEvent?: (event: OnlineGameEvent) => void
}

function App({
  initialGamePlayers = defaultPlayers,
  localPlayerId,
  onlineState,
  publishOnlineState,
  beginOnlineTurnAction,
  turnDeadline,
  turnTimeoutSignal,
  onReturnToLobby,
  sendOnlineChat,
  disconnectedPlayerIds = [],
  onlineGameEvent,
  acknowledgeOnlineGameEvent,
  sendOnlineGameEvent,
}: AppProps) {
  const [players, setPlayers] = useState<Player[]>(initialGamePlayers)
  const [activePlayerIndex, setActivePlayerIndex] = useState(0)
  const [owners, setOwners] = useState<Record<number, string>>({})
  const [propertyLevels, setPropertyLevels] = useState<Record<number, number>>({})
  const [mortgagedPropertyIds, setMortgagedPropertyIds] = useState<number[]>([])
  const [mortgageExpiryTurns, setMortgageExpiryTurns] = useState<Record<number, number>>({})
  const [turnSequence, setTurnSequence] = useState(0)
  const [logs, setLogs] = useState<LogEntry[]>([
    createLog('Игра готова. Рандом собирается из рынков, ПК и случайного градусника.'),
  ])
  const [lastRoll, setLastRoll] = useState<DiceRoll | null>(null)
  const [pendingTileId, setPendingTileId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [isRolling, setIsRolling] = useState(false)
  const [diceAnimation, setDiceAnimation] = useState<{ id: number; values: [number, number] } | null>(null)
  const [movingPlayerId, setMovingPlayerId] = useState<string | null>(null)
  const [hoveredOwnerId, setHoveredOwnerId] = useState<string | null>(null)
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)
  const [tradeHistoryPreview, setTradeHistoryPreview] = useState<Record<number, string>>({})
  const [selectedPropertyId, setSelectedPropertyId] = useState<number | null>(null)
  const [interactionPlayerId, setInteractionPlayerId] = useState<string | null>(null)
  const [tradeDraft, setTradeDraft] = useState<TradeDraft | null>(null)
  const [auction, setAuction] = useState<AuctionState | null>(null)
  const [auctionBid, setAuctionBid] = useState(String(auctionIncrement))
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null)
  const [eventPaymentQueue, setEventPaymentQueue] = useState<EventPayment[]>([])
  const [hasExtraRoll, setHasExtraRoll] = useState(false)
  const [jailedPlayerIds, setJailedPlayerIds] = useState<string[]>([])
  const [jailFailedAttempts, setJailFailedAttempts] = useState<Record<string, number>>({})
  const [casino, setCasino] = useState<CasinoState | null>(null)
  const [casinoJackpot, setCasinoJackpot] = useState(initialCasinoJackpot)
  const [upgradedGroupsThisTurn, setUpgradedGroupsThisTurn] = useState<string[]>([])
  const [playerEffects, setPlayerEffects] = useState<Record<string, PlayerEffects>>({})
  const [lapCounts, setLapCounts] = useState<Record<string, number>>({})
  const [tradeRequestsThisTurn, setTradeRequestsThisTurn] = useState(0)
  const [missedTurnCounts, setMissedTurnCounts] = useState<Record<string, number>>({})
  const [eliminatedPlayerIds, setEliminatedPlayerIds] = useState<string[]>([])
  const [winnerId, setWinnerId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [minimalistChat, setMinimalistChat] = useState(readMinimalistChatPreference)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const movingTokenRef = useRef<HTMLSpanElement | null>(null)
  const logListRef = useRef<HTMLDivElement | null>(null)
  const keepLogPinnedRef = useRef(true)
  const previousLogCountRef = useRef(0)
  const [unreadLogCount, setUnreadLogCount] = useState(0)
  const propertyDialogRef = useRef<HTMLElement | null>(null)
  const ownerHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTurnSoundKeyRef = useRef<string | null>(null)
  const lastTurnWarningSoundKeyRef = useRef<string | null>(null)
  const lastTradeSoundKeyRef = useRef<string | null>(null)
  const lastAuctionSoundKeyRef = useRef<string | null>(null)
  const appliedOnlineRevisionRef = useRef(0)
  const applyingOnlineStateRef = useRef(false)
  const serverForcedActionRef = useRef(false)
  const suspendOnlinePublishRef = useRef(false)
  const forcedOnlinePublishRef = useRef(false)
  const movingPlayerIdRef = useRef<string | null>(null)
  const movementDestinationRef = useRef<number | null>(null)
  const diceAnimationIdRef = useRef(0)
  const diceAnimationTimerRef = useRef<number | null>(null)
  const diceAnimationResolverRef = useRef<(() => void) | null>(null)
  const onlinePublishAuthorityRef = useRef(
    !localPlayerId || localPlayerId === initialGamePlayers[0]?.id,
  )
  const handledTimeoutIdsRef = useRef(new Set<string>())
  const [turnClockNow, setTurnClockNow] = useState(0)
  const [forcedPublishTick, setForcedPublishTick] = useState(0)

  const finishDiceRollAnimation = () => {
    if (diceAnimationTimerRef.current !== null) window.clearTimeout(diceAnimationTimerRef.current)
    diceAnimationTimerRef.current = null
    setDiceAnimation(null)
    const resolve = diceAnimationResolverRef.current
    diceAnimationResolverRef.current = null
    resolve?.()
  }

  const playDiceRollAnimation = (values: [number, number]) => {
    if (!diceRollAnimationEnabled) return Promise.resolve()
    finishDiceRollAnimation()
    return new Promise<void>((resolve) => {
      diceAnimationIdRef.current += 1
      diceAnimationResolverRef.current = resolve
      setDiceAnimation({ id: diceAnimationIdRef.current, values })
      diceAnimationTimerRef.current = window.setTimeout(finishDiceRollAnimation, diceRollAnimationDuration)
    })
  }

  useEffect(() => () => finishDiceRollAnimation(), [])

  const activePlayer = players[activePlayerIndex]
  const movingPlayer = movingPlayerId ? players.find((player) => player.id === movingPlayerId) ?? null : null
  const canLocalPlayerAct = !localPlayerId || localPlayerId === activePlayer.id
  const canLocalPlayerPay = !localPlayerId || localPlayerId === pendingPayment?.payerId
  const canActNow = () => canLocalPlayerAct || serverForcedActionRef.current
  const secondsLeft = turnDeadline && turnClockNow
    ? Math.min(70, Math.max(0, Math.ceil((turnDeadline - turnClockNow) / 1000)))
    : 70

  useEffect(() => {
    const unlockAudio = () => unlockGameAudio()
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    window.addEventListener('keydown', unlockAudio, { once: true })

    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [])

  useEffect(() => {
    if (localPlayerId) return
    const turnSoundKey = `${turnSequence}:${activePlayer.id}`
    if (lastTurnSoundKeyRef.current === turnSoundKey) return
    lastTurnSoundKeyRef.current = turnSoundKey
    if (
      winnerId || auction || tradeDraft || pendingPayment || pendingTileId !== null || casino ||
      (localPlayerId && localPlayerId !== activePlayer.id)
    ) return

    playGameSound('turn')
  }, [activePlayer.id, auction, casino, localPlayerId, pendingPayment, pendingTileId, tradeDraft, turnSequence, winnerId])

  useEffect(() => {
    if (
      secondsLeft <= 0 || secondsLeft > 15 || isRolling || winnerId || auction || tradeDraft ||
      pendingPayment || pendingTileId !== null || casino ||
      (localPlayerId && localPlayerId !== activePlayer.id)
    ) return

    const warningKey = `${turnSequence}:${activePlayer.id}`
    if (lastTurnWarningSoundKeyRef.current === warningKey) return
    lastTurnWarningSoundKeyRef.current = warningKey
    playGameSound('warning')
  }, [activePlayer.id, auction, casino, isRolling, localPlayerId, pendingPayment, pendingTileId, secondsLeft, tradeDraft, turnSequence, winnerId])

  useEffect(() => {
    if (localPlayerId) return
    const tradeSoundKey = tradeDraft?.stage === 'review'
      ? `${turnSequence}:${activePlayer.id}:${tradeDraft.targetPlayerId}:${tradeDraft.offeredMoney}:${tradeDraft.requestedMoney}:${tradeDraft.offeredTileIds.join(',')}:${tradeDraft.requestedTileIds.join(',')}`
      : null
    if (!tradeSoundKey) {
      lastTradeSoundKeyRef.current = null
      return
    }
    if (lastTradeSoundKeyRef.current === tradeSoundKey) return
    lastTradeSoundKeyRef.current = tradeSoundKey
    if (localPlayerId && localPlayerId !== tradeDraft?.targetPlayerId) return

    playGameSound('trade')
  }, [activePlayer.id, localPlayerId, tradeDraft, turnSequence])

  useEffect(() => {
    if (localPlayerId) return
    const auctionSoundKey = auction
      ? `${turnSequence}:${auction.tileId}:${auction.activeBidderId}:${auction.currentBid}:${auction.highestBidderId ?? 'none'}:${auction.passedIds.join(',')}`
      : null
    if (!auctionSoundKey) {
      lastAuctionSoundKeyRef.current = null
      return
    }
    if (lastAuctionSoundKeyRef.current === auctionSoundKey) return
    lastAuctionSoundKeyRef.current = auctionSoundKey
    if (localPlayerId && localPlayerId !== auction?.activeBidderId) return

    playGameSound('trade')
  }, [auction, localPlayerId, turnSequence])

  useEffect(() => {
    if (!turnDeadline) return
    const syncClock = () => setTurnClockNow(Date.now())
    syncClock()
    const timer = window.setInterval(() => setTurnClockNow(Date.now()), 250)
    window.addEventListener('focus', syncClock)
    document.addEventListener('visibilitychange', syncClock)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', syncClock)
      document.removeEventListener('visibilitychange', syncClock)
    }
  }, [turnDeadline])

  useEffect(() => {
    if (!winnerId || !onReturnToLobby) return
    const timer = window.setTimeout(onReturnToLobby, 3000)
    return () => window.clearTimeout(timer)
  }, [onReturnToLobby, winnerId])
  const isActivePlayerJailed = jailedPlayerIds.includes(activePlayer.id)
  const activeJailFailedAttempts = jailFailedAttempts[activePlayer.id] ?? 0
  const isForcedJailRelease = isActivePlayerJailed && activeJailFailedAttempts >= 3
  const casinoPlayer = casino ? players.find((player) => player.id === casino.playerId) ?? null : null
  const pendingTile = pendingTileId === null ? null : tiles.find((tile) => tile.id === pendingTileId) ?? null
  const pendingPurchaseShortage = pendingTile
    ? Math.max(0, (pendingTile.price ?? 0) - activePlayer.money)
    : 0
  const selectedProperty =
    selectedPropertyId === null ? null : brandTiles.find((tile) => tile.id === selectedPropertyId) ?? null
  const selectedPropertyOwnerId = selectedProperty ? owners[selectedProperty.id] ?? null : null
  const selectedUpgradeCost = selectedProperty
    ? Math.max(50, getUpgradeCost(selectedProperty) - (playerEffects[activePlayer.id]?.upgradeDiscount ?? 0))
    : 0
  const previewedPlayerId = hoveredOwnerId ?? selectedPropertyOwnerId
  const tradeTarget = tradeDraft ? players.find((player) => player.id === tradeDraft.targetPlayerId) ?? null : null
  const canLocalPlayerAnswerTrade = !localPlayerId || localPlayerId === tradeDraft?.targetPlayerId
  const canLocalPlayerEditTradeDraft = Boolean(
    tradeDraft?.stage === 'draft' && (!localPlayerId || localPlayerId === activePlayer.id),
  )
  const canLocalPlayerSeeTrade = Boolean(
    tradeDraft && (
      !localPlayerId || (
        tradeDraft.stage === 'draft'
          ? localPlayerId === activePlayer.id
          : localPlayerId === tradeDraft.targetPlayerId
      )
    ),
  )
  const canLocalPlayerUsePropertyActions = canLocalPlayerAct && !tradeDraft && !auction && !casino
  const onlineDecisionPlayerId = tradeDraft?.stage === 'review'
    ? tradeDraft.targetPlayerId
    : auction?.activeBidderId
      ?? pendingPayment?.payerId
      ?? casino?.playerId
      ?? activePlayer.id
  const decisionPlayer = players.find((player) => player.id === onlineDecisionPlayerId) ?? activePlayer
  const canLocalPlayerUseTurnControls = !localPlayerId || (
    localPlayerId === activePlayer.id && onlineDecisionPlayerId === activePlayer.id
  )
  const canLocalPlayerBidAtAuction = !localPlayerId || localPlayerId === auction?.activeBidderId
  const auctionTile = auction ? brandTiles.find((tile) => tile.id === auction.tileId) ?? null : null
  const auctionBidder = auction ? players.find((player) => player.id === auction.activeBidderId) ?? null : null
  const remainingAuctionBidderIds = auction
    ? auction.participantIds.filter((id) => !auction.passedIds.includes(id) && !eliminatedPlayerIds.includes(id))
    : []
  const isSoleAuctionDecision = Boolean(
    auction &&
    auction.highestBidderId === null &&
    remainingAuctionBidderIds.length === 1 &&
    remainingAuctionBidderIds[0] === auction.activeBidderId,
  )
  const paymentPayer = pendingPayment
    ? players.find((player) => player.id === pendingPayment.payerId) ?? null
    : null
  const paymentRecipient = pendingPayment
    ? players.find((player) => player.id === pendingPayment.recipientId) ?? null
    : null
  const paymentTile = pendingPayment
    ? tiles.find((tile) => tile.id === pendingPayment.tileId) ?? null
    : null

  useEffect(() => {
    if (!onlineState || onlineState.revision <= appliedOnlineRevisionRef.current) return
    const state = onlineState.state
    applyingOnlineStateRef.current = true
    const incomingDecisionPlayerId = state.tradeDraft?.stage === 'review'
      ? state.tradeDraft.targetPlayerId
      : state.auction?.activeBidderId
        ?? state.pendingPayment?.payerId
        ?? state.casino?.playerId
        ?? state.players[state.activePlayerIndex]?.id
    onlinePublishAuthorityRef.current = !localPlayerId || localPlayerId === incomingDecisionPlayerId
    appliedOnlineRevisionRef.current = onlineState.revision
    const incomingEliminatedIds = state.eliminatedPlayerIds ?? []
    setPlayers((currentPlayers) => {
      const movingId = movingPlayerIdRef.current
      const movingPosition = currentPlayers.find((player) => player.id === movingId)?.position
      return state.players.map((player) => {
        const normalizedPlayer = incomingEliminatedIds.includes(player.id)
          ? { ...player, money: 0, lastDelta: 0 }
          : player
        return player.id === movingId && movingPosition !== undefined
          ? { ...normalizedPlayer, position: movingPosition }
          : normalizedPlayer
      })
    })
    setActivePlayerIndex(state.activePlayerIndex)
    setOwners(state.owners)
    setPropertyLevels(state.propertyLevels)
    setMortgagedPropertyIds(state.mortgagedPropertyIds)
    setMortgageExpiryTurns(state.mortgageExpiryTurns)
    setTurnSequence(state.turnSequence)
    setLogs((current) => {
      const currentLastId = current.at(-1)?.id
      const incomingLastId = state.logs.at(-1)?.id
      return current.length === state.logs.length && currentLastId === incomingLastId ? current : state.logs
    })
    setLastRoll(state.lastRoll)
    setPendingTileId(state.pendingTileId)
    setTradeDraft(state.tradeDraft)
    setAuction(state.auction)
    setPendingPayment(state.pendingPayment)
    setEventPaymentQueue(state.eventPaymentQueue)
    setHasExtraRoll(state.hasExtraRoll)
    setJailedPlayerIds(state.jailedPlayerIds)
    setJailFailedAttempts(state.jailFailedAttempts)
    setCasino(state.casino)
    setCasinoJackpot(state.casinoJackpot)
    setUpgradedGroupsThisTurn(state.upgradedGroupsThisTurn)
    setPlayerEffects(state.playerEffects)
    setLapCounts(state.lapCounts)
    setTradeRequestsThisTurn(state.tradeRequestsThisTurn ?? 0)
    setMissedTurnCounts(state.missedTurnCounts ?? {})
    setEliminatedPlayerIds(incomingEliminatedIds)
    setWinnerId(state.winnerId ?? null)
    window.requestAnimationFrame(() => {
      applyingOnlineStateRef.current = false
    })
  }, [localPlayerId, onlineState])

  useEffect(() => {
    if (
      !publishOnlineState ||
      applyingOnlineStateRef.current ||
      suspendOnlinePublishRef.current ||
      (!onlinePublishAuthorityRef.current && !forcedOnlinePublishRef.current)
    ) return
    publishOnlineState({
      players,
      activePlayerIndex,
      owners,
      propertyLevels,
      mortgagedPropertyIds,
      mortgageExpiryTurns,
      turnSequence,
      logs,
      lastRoll,
      pendingTileId,
      tradeDraft,
      auction,
      pendingPayment,
      eventPaymentQueue,
      hasExtraRoll,
      jailedPlayerIds,
      jailFailedAttempts,
      casino,
      casinoJackpot,
      upgradedGroupsThisTurn,
      playerEffects,
      lapCounts,
      tradeRequestsThisTurn,
      missedTurnCounts,
      eliminatedPlayerIds,
      winnerId,
    })
    onlinePublishAuthorityRef.current = !localPlayerId || localPlayerId === onlineDecisionPlayerId
    forcedOnlinePublishRef.current = false
  }, [
    activePlayerIndex, auction, casino, casinoJackpot, eliminatedPlayerIds, eventPaymentQueue, hasExtraRoll,
    jailFailedAttempts, jailedPlayerIds, lapCounts, lastRoll, localPlayerId, logs, missedTurnCounts,
    mortgageExpiryTurns, mortgagedPropertyIds, owners, pendingPayment,
    pendingTileId, playerEffects, players, propertyLevels, publishOnlineState, tradeDraft,
    tradeRequestsThisTurn, turnSequence, upgradedGroupsThisTurn, winnerId, onlineDecisionPlayerId,
    forcedPublishTick,
  ])

  const playersByTile = useMemo(() => {
    return players.reduce<Record<number, Player[]>>((acc, player) => {
      if (eliminatedPlayerIds.includes(player.id)) return acc
      acc[player.position] = [...(acc[player.position] ?? []), player]
      return acc
    }, {})
  }, [eliminatedPlayerIds, players])

  const subscriptionCountsByOwner = useMemo(() => subscriptionTiles.reduce<Record<string, number>>(
    (counts, tile) => {
      const ownerId = owners[tile.id]
      if (ownerId) counts[ownerId] = (counts[ownerId] ?? 0) + 1
      return counts
    },
    {},
  ), [owners])

  const completedGroups = useMemo(() => {
    const result: Record<string, Player> = {}

    Object.keys(groupColors).forEach((group) => {
      const groupTiles = brandTiles.filter((tile) => tile.group === group)
      const firstOwnerId = groupTiles.length > 0 ? owners[groupTiles[0].id] : undefined

      if (firstOwnerId && groupTiles.every((tile) => owners[tile.id] === firstOwnerId)) {
        const owner = players.find((player) => player.id === firstOwnerId)
        if (owner) result[group] = owner
      }
    })

    return result
  }, [owners, players])

  const playersByName = useMemo(() => new Map(
    players.map((player) => [player.name.toLocaleLowerCase('ru-RU'), player]),
  ), [players])
  const eventTextPattern = useMemo(() => {
    const playerNames = players
      .map((player) => player.name)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|')
    const alternatives = [
      '\\$\\d[\\d\\s\\u00a0]*k',
      ...eventHighlightBaseTokens.map(escapeRegExp),
      playerNames ? `(?<![\\p{L}\\p{N}_])(?:${playerNames})(?![\\p{L}\\p{N}_])` : '',
    ].filter(Boolean)
    return new RegExp(`(${alternatives.join('|')})`, 'giu')
  }, [players])

  const renderEventText = (entry: LogEntry) => {
    return entry.text.split(eventTextPattern).map((part, index) => {
      if (!part) return null

      const mentionedPlayer = playersByName.get(part.toLocaleLowerCase('ru-RU'))
      if (mentionedPlayer) {
        return (
          <span
            className="event-player-name"
            key={`${entry.id}-player-${index}`}
            style={{ '--mentioned-player-color': mentionedPlayer.color } as CSSProperties}
          >
            {part}
          </span>
        )
      }

      if (/^\$/u.test(part)) {
        return (
          <span className="event-money-highlight" key={`${entry.id}-money-${index}`}>
            {part}
          </span>
        )
      }

      if (part.toLocaleLowerCase('ru-RU') === 'шанс') {
        return (
          <span className="event-chance-highlight" key={`${entry.id}-chance-${index}`}>
            {part}
          </span>
        )
      }

      if (part.toLocaleLowerCase('ru-RU') === 'алмазик') {
        return (
          <span className="event-diamond-highlight" key={`${entry.id}-diamond-${index}`}>
            {part}
          </span>
        )
      }

      const tile = brandTilesByName.get(part.toLocaleLowerCase('ru-RU'))
      if (!tile) return part

      const owner = players.find((player) => player.id === owners[tile.id])

      return (
        <span
          className={`event-company ${owner ? 'owned' : 'unowned'}`}
          key={`${entry.id}-company-${index}`}
          style={{ '--company-color': owner?.color ?? '#aab3bd' } as CSSProperties}
        >
          {part}
        </span>
      )
    })
  }

  useEffect(() => {
    const logList = logListRef.current
    const addedLogs = Math.max(0, logs.length - previousLogCountRef.current)
    previousLogCountRef.current = logs.length

    if (logList && keepLogPinnedRef.current) {
      logList.scrollTo({ top: logList.scrollHeight, behavior: logs.length > 1 ? 'smooth' : 'auto' })
      setUnreadLogCount(0)
    } else if (addedLogs > 0) {
      setUnreadLogCount((count) => count + addedLogs)
    }
  }, [logs])

  const scrollToLatestLogs = () => {
    const logList = logListRef.current
    if (!logList) return
    keepLogPinnedRef.current = true
    setUnreadLogCount(0)
    logList.scrollTo({ top: logList.scrollHeight, behavior: 'smooth' })
  }

  useEffect(() => {
    return () => {
      if (ownerHoverTimerRef.current) clearTimeout(ownerHoverTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!selectedProperty) return

    const closePropertyOnOutsideClick = (event: PointerEvent) => {
      if (!propertyDialogRef.current?.contains(event.target as Node)) {
        setSelectedPropertyId(null)
      }
    }

    document.addEventListener('pointerdown', closePropertyOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closePropertyOnOutsideClick)
  }, [selectedProperty])

  const nextTurn = () => {
    const nextTurnSequence = turnSequence + 1
    const expiredMortgageIds = Object.entries(mortgageExpiryTurns)
      .filter(([, expiresAt]) => expiresAt <= nextTurnSequence)
      .map(([tileId]) => Number(tileId))

    if (expiredMortgageIds.length > 0) {
      setOwners((items) => {
        const next = { ...items }
        expiredMortgageIds.forEach((id) => delete next[id])
        return next
      })
      setPropertyLevels((items) => {
        const next = { ...items }
        expiredMortgageIds.forEach((id) => delete next[id])
        return next
      })
      setMortgagedPropertyIds((ids) => ids.filter((id) => !expiredMortgageIds.includes(id)))
      setLogs((items) => [
        ...items,
        ...expiredMortgageIds.map((id) => {
          const tile = brandTiles.find((item) => item.id === id)
          return createLog(`Срок выкупа ${tile?.name ?? 'заложенного поля'} истек — поле возвращается банку`, undefined, 'mortgage')
        }),
      ])
    }

    setMortgageExpiryTurns((items) => {
      const next = { ...items }
      expiredMortgageIds.forEach((id) => delete next[id])
      return next
    })
    setTurnSequence(nextTurnSequence)
    setTradeRequestsThisTurn(0)
    setUpgradedGroupsThisTurn([])
    setHasExtraRoll(false)

    let nextIndex = (activePlayerIndex + 1) % players.length
    const skippedPlayers: Player[] = []
    const nextEffects = { ...playerEffects }

    for (let checked = 0; checked < players.length; checked += 1) {
      const candidate = players[nextIndex]
      if (eliminatedPlayerIds.includes(candidate.id)) {
        nextIndex = (nextIndex + 1) % players.length
        continue
      }
      const skipTurns = nextEffects[candidate.id]?.skipTurns ?? 0
      if (skipTurns <= 0) break

      skippedPlayers.push(candidate)
      nextEffects[candidate.id] = {
        ...nextEffects[candidate.id],
        skipTurns: skipTurns - 1,
      }
      nextIndex = (nextIndex + 1) % players.length
    }

    if (skippedPlayers.length > 0) {
      setPlayerEffects(nextEffects)
      setLogs((items) => [
        ...items,
        ...skippedPlayers.map((player) =>
          createLog(`${player.name} пропускает ход`, player.id, 'chance'),
        ),
      ])
    }

    setActivePlayerIndex(nextIndex)
  }

  const completeTurn = (extraRoll = hasExtraRoll) => {
    if (extraRoll) {
      setHasExtraRoll(false)
      setUpgradedGroupsThisTurn([])
      return
    }

    nextTurn()
  }

  const applyMoneyDeltas = (deltas: Record<string, number>) => {
    const activeDeltas = Object.fromEntries(
      Object.entries(deltas).filter(([playerId]) => !eliminatedPlayerIds.includes(playerId)),
    )
    const cancelledChallenges = Object.entries(activeDeltas)
      .filter(([playerId, delta]) => delta < 0 && playerEffects[playerId]?.bookChallenge)
      .map(([playerId]) => playerId)

    if (cancelledChallenges.length > 0) {
      setPlayerEffects((items) => {
        const next = { ...items }
        cancelledChallenges.forEach((playerId) => {
          next[playerId] = { ...next[playerId], bookChallenge: false }
        })
        return next
      })
      setLogs((items) => [
        ...items,
        ...cancelledChallenges.map((playerId) => {
          const player = players.find((item) => item.id === playerId)
          return createLog(
            `${player?.name ?? 'Игрок'} тратит деньги и проваливает испытание книги`,
            playerId,
            'chance',
          )
        }),
      ])
    }

    setPlayers((items) =>
      items.map((item) => {
        if (eliminatedPlayerIds.includes(item.id)) {
          return item.money === 0 && (item.lastDelta ?? 0) === 0
            ? item
            : { ...item, money: 0, lastDelta: 0 }
        }
        const delta = activeDeltas[item.id]

        if (delta === undefined) return item

        return {
          ...item,
          money: item.money + delta,
          lastDelta: delta,
        }
      }),
    )
  }

  const getPlayerMaximumCash = (playerId: string) => {
    const player = players.find((item) => item.id === playerId)
    if (!player) return 0

    return brandTiles.reduce((total, tile) => {
      if (owners[tile.id] !== playerId) return total
      const starsValue = (propertyLevels[tile.id] ?? 0) * getStarSaleValue(tile)
      const mortgageValue = mortgagedPropertyIds.includes(tile.id) ? 0 : getMortgageValue(tile)
      return total + starsValue + mortgageValue
    }, player.money)
  }

  const startEventPaymentSequence = (payments: EventPayment[]) => {
    const validPayments = payments.filter((payment) =>
      payment.amount > 0 &&
      !eliminatedPlayerIds.includes(payment.payerId) &&
      (!payment.recipientId || !eliminatedPlayerIds.includes(payment.recipientId)))
    const [firstPayment, ...remainingPayments] = validPayments

    if (!firstPayment) {
      completeTurn()
      return
    }

    setEventPaymentQueue(remainingPayments)
    setPendingPayment({
      payerId: firstPayment.payerId,
      recipientId: firstPayment.recipientId,
      tileId: firstPayment.tileId,
      amount: firstPayment.amount,
      kind: 'event',
      eventLabel: firstPayment.label,
    })
  }

  const surrenderPlayer = (playerId: string) => {
    const canSurrenderPlayer = playerId === activePlayer.id || pendingPayment?.payerId === playerId
    if ((!canActNow() && !canLocalPlayerPay) || !canSurrenderPlayer || eliminatedPlayerIds.includes(playerId)) return
    const player = players.find((item) => item.id === playerId)
    if (!player) return

    const surrenderedTileIds = brandTiles.filter((tile) => owners[tile.id] === playerId).map((tile) => tile.id)
    const remainingPlayers = players.filter((item) => item.id !== playerId && !eliminatedPlayerIds.includes(item.id))
    setPlayers((items) => items.map((item) =>
      item.id === playerId ? { ...item, money: 0, lastDelta: 0 } : item))
    setEliminatedPlayerIds((ids) => [...new Set([...ids, playerId])])
    setJailedPlayerIds((ids) => ids.filter((id) => id !== playerId))
    setJailFailedAttempts((items) => {
      const next = { ...items }
      delete next[playerId]
      return next
    })
    setPlayerEffects((items) => {
      const next = { ...items }
      delete next[playerId]
      return next
    })
    setLapCounts((items) => {
      const next = { ...items }
      delete next[playerId]
      return next
    })
    setOwners((items) => {
      const next = { ...items }
      surrenderedTileIds.forEach((id) => delete next[id])
      return next
    })
    setPropertyLevels((items) => {
      const next = { ...items }
      surrenderedTileIds.forEach((id) => delete next[id])
      return next
    })
    setMortgagedPropertyIds((ids) => ids.filter((id) => !surrenderedTileIds.includes(id)))
    setMortgageExpiryTurns((items) => {
      const next = { ...items }
      surrenderedTileIds.forEach((id) => delete next[id])
      return next
    })
    setPendingPayment(null)
    setEventPaymentQueue([])
    setPendingTileId(null)
    setAuction(null)
    setCasino(null)
    setSelectedPropertyId(null)
    setInteractionPlayerId(null)
    setTradeDraft(null)
    setHasExtraRoll(false)
    setUpgradedGroupsThisTurn([])
    setLogs((items) => [
      ...items,
      createLog(`${player.name} сдается и выбывает из игры`, player.id, 'bankruptcy'),
      ...(remainingPlayers.length === 1
        ? [createLog(`${remainingPlayers[0].name} побеждает в игре!`, remainingPlayers[0].id, 'rent')]
        : []),
    ])
    if (remainingPlayers.length === 1) setWinnerId(remainingPlayers[0].id)
    else nextTurn()
  }

  const payPendingRent = () => {
    if ((!canLocalPlayerPay && !serverForcedActionRef.current) || !pendingPayment) return
    const payer = players.find((player) => player.id === pendingPayment.payerId)
    const recipient = pendingPayment.recipientId
      ? players.find((player) => player.id === pendingPayment.recipientId)
      : null
    if (!payer || (pendingPayment.kind === 'rent' && !recipient) || payer.money < pendingPayment.amount) return

    applyMoneyDeltas(
      recipient
        ? { [payer.id]: -pendingPayment.amount, [recipient.id]: pendingPayment.amount }
        : { [payer.id]: -pendingPayment.amount },
    )
    setLogs((items) => [
      ...items,
      createLog(
        pendingPayment.kind === 'rent'
          ? isSubscriptionTile(paymentTile ?? tiles[pendingPayment.tileId])
            ? `${payer.name} оплачивает подписку ${paymentTile?.name ?? ''} игроку ${recipient?.name ?? 'владельцу'}: ${money(pendingPayment.amount)}`
            : `${payer.name} платит аренду ${recipient?.name ?? 'владельцу'}: ${money(pendingPayment.amount)}`
          : pendingPayment.kind === 'tax'
            ? `${payer.name} платит налог банку: ${money(pendingPayment.amount)}`
            : `${payer.name} оплачивает событие «${pendingPayment.eventLabel ?? 'Вопросик'}»: ${money(pendingPayment.amount)}`,
        payer.id,
        pendingPayment.kind === 'event'
          ? pendingPayment.eventLabel === 'Алмазик' ? 'diamond' : 'chance'
          : pendingPayment.kind,
        -pendingPayment.amount,
      ),
    ])

    if (pendingPayment.kind === 'event' && eventPaymentQueue.length > 0) {
      const [nextPayment, ...remainingPayments] = eventPaymentQueue
      setEventPaymentQueue(remainingPayments)
      setPendingPayment({
        payerId: nextPayment.payerId,
        recipientId: nextPayment.recipientId,
        tileId: nextPayment.tileId,
        amount: nextPayment.amount,
        kind: 'event',
        eventLabel: nextPayment.label,
      })
      return
    }

    setEventPaymentQueue([])
    setPendingPayment(null)
    completeTurn()
  }

  const payJailRelease = () => {
    if (!canActNow() || !isActivePlayerJailed) return

    if (playerEffects[activePlayer.id]?.freeJailRelease) {
      setPlayerEffects((items) => ({
        ...items,
        [activePlayer.id]: { ...items[activePlayer.id], freeJailRelease: false },
      }))
      setJailedPlayerIds((ids) => ids.filter((id) => id !== activePlayer.id))
      setJailFailedAttempts((items) => {
        const next = { ...items }
        delete next[activePlayer.id]
        return next
      })
      setLogs((items) => [
        ...items,
        createLog(`${activePlayer.name} вызывает адвоката и бесплатно выходит из тюрьмы`, activePlayer.id, 'jail'),
      ])
      return
    }

    if (activePlayer.money < jailReleaseCost) return

    applyMoneyDeltas({ [activePlayer.id]: -jailReleaseCost })
    setJailedPlayerIds((ids) => ids.filter((id) => id !== activePlayer.id))
    setJailFailedAttempts((items) => {
      const next = { ...items }
      delete next[activePlayer.id]
      return next
    })
    setLogs((items) => [
      ...items,
      createLog(
        `${activePlayer.name} оплачивает выход из тюрьмы: ${money(jailReleaseCost)}`,
        activePlayer.id,
        'jail',
        -jailReleaseCost,
      ),
    ])
  }

  const toggleCasinoNumber = (value: number) => {
    if (!canActNow()) return
    setCasino((current) => {
      if (!current || current.rolledNumber !== undefined) return current
      const isSelected = current.selectedNumbers.includes(value)
      if (!isSelected && current.selectedNumbers.length >= 3) return current

      return {
        ...current,
        selectedNumbers: isSelected
          ? current.selectedNumbers.filter((number) => number !== value)
          : [...current.selectedNumbers, value],
      }
    })
  }

  const declineCasino = () => {
    if (!canActNow() || !casino || !casinoPlayer || casino.rolledNumber !== undefined) return
    setLogs((items) => [
      ...items,
      createLog(`${casinoPlayer.name} отказывается делать ставку в казино`, casinoPlayer.id, 'jackpot'),
    ])
    setCasino(null)
    completeTurn()
  }

  const playCasino = async () => {
    if (
      !canActNow() ||
      !casino ||
      !casinoPlayer ||
      casino.rolledNumber !== undefined ||
      casino.selectedNumbers.length < 1 ||
      casino.selectedNumbers.length > 3 ||
      casinoPlayer.money < casinoBet ||
      isRolling
    ) return

    setIsRolling(true)
    const roll = await rollComplexDice()
    const rolledNumber = roll.dice[0]
    const guessed = casino.selectedNumbers.includes(rolledNumber)
    const payoutMultiplier = 6 / casino.selectedNumbers.length
    const regularPayout = guessed ? Math.round(casinoBet * payoutMultiplier) : 0
    const jackpotWon = roll.dice[0] === 6 && roll.dice[1] === 6
    const totalPayout = regularPayout + (jackpotWon ? casinoJackpot : 0)
    const balanceDelta = totalPayout - casinoBet

    applyMoneyDeltas({ [casinoPlayer.id]: balanceDelta })
    setCasino({
      ...casino,
      rolledNumber,
      payout: totalPayout,
      jackpotWon,
    })
    setCasinoJackpot(jackpotWon ? initialCasinoJackpot : casinoJackpot + casinoJackpotStep)
    setLogs((items) => [
      ...items,
      createLog(`${casinoPlayer.name} ставит ${money(casinoBet)} на числа ${casino.selectedNumbers.join(', ')}`, casinoPlayer.id, 'jackpot'),
      createLog(`Кубик казино показывает ${rolledNumber}`, casinoPlayer.id, 'roll'),
      createLog(
        jackpotWon
          ? `${casinoPlayer.name} срывает суперприз и получает ${money(totalPayout)}`
          : guessed
            ? `${casinoPlayer.name} угадывает число и получает ${money(totalPayout)}`
            : `${casinoPlayer.name} не угадывает число и проигрывает ${money(casinoBet)}`,
        casinoPlayer.id,
        'jackpot',
        balanceDelta,
      ),
    ])
    setIsRolling(false)
  }

  const finishCasino = () => {
    if (!casino || casino.rolledNumber === undefined) return
    setCasino(null)
    completeTurn()
  }

  const startOwnerPreview = (playerId: string) => {
    if (ownerHoverTimerRef.current) clearTimeout(ownerHoverTimerRef.current)
    ownerHoverTimerRef.current = null
    setHoveredOwnerId(playerId)
  }

  const stopOwnerPreview = () => {
    if (ownerHoverTimerRef.current) clearTimeout(ownerHoverTimerRef.current)
    ownerHoverTimerRef.current = null
    setHoveredOwnerId(null)
  }

  const closeDialogs = () => {
    setSelectedPropertyId(null)
    setInteractionPlayerId(null)
    setTradeDraft(null)
  }

  const finishAuction = (state: AuctionState, winnerId: string | null, winningBid = 0) => {
    const tile = brandTiles.find((item) => item.id === state.tileId)
    if (!tile) return
    const eligibleWinnerId = winnerId &&
      state.participantIds.includes(winnerId) &&
      !eliminatedPlayerIds.includes(winnerId)
      ? winnerId
      : null

    if (eligibleWinnerId) {
      const winner = players.find((player) => player.id === eligibleWinnerId)
      setOwners((items) => ({ ...items, [tile.id]: eligibleWinnerId }))
      applyMoneyDeltas({ [eligibleWinnerId]: -winningBid })
      setLogs((items) => [
        ...items,
        createLog(
          `${winner?.name ?? 'Игрок'} выигрывает аукцион за ${tile.name}: ${money(winningBid)}`,
          eligibleWinnerId,
          'auction',
          -winningBid,
        ),
      ])
    } else {
      setLogs((items) => [...items, createLog(`Аукцион за ${tile.name} завершен без покупателя`, undefined, 'auction')])
    }

    setAuction(null)
    setAuctionBid(String(auctionIncrement))
    completeTurn()
  }

  const placeAuctionBid = () => {
    if (!auction || !auctionTile || !auctionBidder || (!serverForcedActionRef.current && localPlayerId && localPlayerId !== auctionBidder.id)) return

    const increase = isSoleAuctionDecision ? auctionIncrement : Math.floor(Number(auctionBid))
    const bid = auction.currentBid + increase
    if (!Number.isFinite(increase) || increase < auctionIncrement || bid > auctionBidder.money) return

    const eligibleOpponents = auction.participantIds.filter((id) => {
      if (id === auctionBidder.id || auction.passedIds.includes(id) || eliminatedPlayerIds.includes(id)) return false
      const player = players.find((item) => item.id === id)
      return Boolean(player && player.money >= bid + auctionIncrement)
    })

    setLogs((items) => [
      ...items,
      createLog(`${auctionBidder.name} ставит ${money(bid)} за ${auctionTile.name}`, auctionBidder.id, 'auction'),
    ])

    if (eligibleOpponents.length === 0) {
      finishAuction(auction, auctionBidder.id, bid)
      return
    }

    setAuction({
      ...auction,
      currentBid: bid,
      highestBidderId: auctionBidder.id,
      activeBidderId: nextParticipant(auction.participantIds, auctionBidder.id, eligibleOpponents),
    })
    setAuctionBid(String(auctionIncrement))
  }

  const passAuction = () => {
    if (!auction || !auctionTile || !auctionBidder || (!serverForcedActionRef.current && localPlayerId && localPlayerId !== auctionBidder.id)) return

    const passedIds = [...new Set([...auction.passedIds, auctionBidder.id])]
    setLogs((items) => [
      ...items,
      createLog(`${auctionBidder.name} выходит из аукциона за ${auctionTile.name}`, auctionBidder.id, 'auction'),
    ])

    const candidates = auction.participantIds.filter((id) => {
      if (passedIds.includes(id) || id === auction.highestBidderId || eliminatedPlayerIds.includes(id)) return false
      const player = players.find((item) => item.id === id)
      return Boolean(player && player.money >= auction.currentBid + auctionIncrement)
    })

    if (candidates.length === 0) {
      finishAuction(auction, auction.highestBidderId, auction.currentBid)
      return
    }

    setAuction({
      ...auction,
      passedIds,
      activeBidderId: nextParticipant(auction.participantIds, auctionBidder.id, candidates),
    })
    setAuctionBid(String(auctionIncrement))
  }

  const openPlayerInteraction = (playerId: string) => {
    const isOwnSurrenderAction = playerId === activePlayer.id && (!localPlayerId || localPlayerId === playerId)
    const isTradeAction = playerId !== activePlayer.id && canLocalPlayerAct
    if (!isOwnSurrenderAction && !isTradeAction) {
      setInteractionPlayerId(null)
      return
    }
    stopOwnerPreview()
    setSelectedPropertyId(null)
    setInteractionPlayerId((currentId) => (currentId === playerId ? null : playerId))
  }

  const beginTrade = (targetPlayerId: string) => {
    if (!canActNow() || tradeRequestsThisTurn >= maxTradeRequestsPerTurn) return
    setInteractionPlayerId(null)
    setTradeDraft({
      targetPlayerId,
      offeredMoney: 0,
      requestedMoney: 0,
      offeredTileIds: [],
      requestedTileIds: [],
      stage: 'draft',
    })
  }

  const toggleTradeTile = (side: 'offered' | 'requested', tileId: number) => {
    if (!canLocalPlayerAct) return
    setTradeDraft((draft) => {
      if (!draft) return draft
      const key = side === 'offered' ? 'offeredTileIds' : 'requestedTileIds'
      const selected = draft[key]

      return {
        ...draft,
        [key]: selected.includes(tileId) ? selected.filter((id) => id !== tileId) : [...selected, tileId],
      }
    })
  }

  const submitTrade = () => {
    if (!canActNow() || !tradeDraft || tradeRequestsThisTurn >= maxTradeRequestsPerTurn) return
    const hasOffer =
      tradeDraft.offeredMoney > 0 ||
      tradeDraft.requestedMoney > 0 ||
      tradeDraft.offeredTileIds.length > 0 ||
      tradeDraft.requestedTileIds.length > 0
    const target = players.find((player) => player.id === tradeDraft.targetPlayerId)

    if (
      !target ||
      !hasOffer ||
      tradeDraft.offeredMoney > activePlayer.money ||
      tradeDraft.requestedMoney > target.money
    ) {
      return
    }

    setTradeRequestsThisTurn((count) => count + 1)
    setTradeDraft({ ...tradeDraft, stage: 'review' })
  }

  const closeSharedTrade = () => {
    const mayClose = tradeDraft?.stage === 'review' ? canLocalPlayerAnswerTrade : canLocalPlayerAct
    if (!mayClose && !serverForcedActionRef.current) return
    closeDialogs()
  }

  const acceptTrade = () => {
    if (!canLocalPlayerAnswerTrade || !tradeDraft) return
    const target = players.find((player) => player.id === tradeDraft.targetPlayerId)
    if (!target) return

    const ownershipIsValid =
      tradeDraft.offeredTileIds.every((id) => owners[id] === activePlayer.id) &&
      tradeDraft.requestedTileIds.every((id) => owners[id] === target.id)

    if (
      !ownershipIsValid ||
      activePlayer.money < tradeDraft.offeredMoney ||
      target.money < tradeDraft.requestedMoney
    ) {
      closeDialogs()
      return
    }

    const activeDelta = tradeDraft.requestedMoney - tradeDraft.offeredMoney
    const targetDelta = -activeDelta
    const tradeAssets = (tileIds: number[]) =>
      tileIds.flatMap((tileId) => {
        const tile = tiles.find((item) => item.id === tileId)
        if (!tile) return []
        const isMortgaged = mortgagedPropertyIds.includes(tileId)

        return [{
          tileId,
          name: tile.name,
          level: propertyLevels[tileId] ?? 0,
          mortgageTurns: isMortgaged
            ? Math.max(0, (mortgageExpiryTurns[tileId] ?? turnSequence) - turnSequence)
            : undefined,
        }]
      })
    const activeReceivedAssets = tradeAssets(tradeDraft.requestedTileIds)
    const targetReceivedAssets = tradeAssets(tradeDraft.offeredTileIds)
    const tradeDetails: TradeLogDetails = {
      sides: [
        {
          playerId: activePlayer.id,
          playerName: activePlayer.name,
          color: activePlayer.color,
          money: tradeDraft.requestedMoney,
          assets: activeReceivedAssets,
        },
        {
          playerId: target.id,
          playerName: target.name,
          color: target.color,
          money: tradeDraft.offeredMoney,
          assets: targetReceivedAssets,
        },
      ],
    }
    const tradeSummary = `${activePlayer.name} получает ${shortTradeBundle(activeReceivedAssets.map((asset) => asset.name), tradeDraft.requestedMoney)} · ${target.name} получает ${shortTradeBundle(targetReceivedAssets.map((asset) => asset.name), tradeDraft.offeredMoney)}`
    applyMoneyDeltas({ [activePlayer.id]: activeDelta, [target.id]: targetDelta })
    setOwners((items) => {
      const next = { ...items }
      tradeDraft.offeredTileIds.forEach((id) => {
        next[id] = target.id
      })
      tradeDraft.requestedTileIds.forEach((id) => {
        next[id] = activePlayer.id
      })
      return next
    })
    setLogs((items) => [
      ...items,
      createLog(tradeSummary, activePlayer.id, 'trade', undefined, tradeDetails),
    ])
    closeDialogs()
  }

  const upgradeSelectedProperty = () => {
    if (!canActNow() || !selectedProperty) return
    if (!isUpgradeableTile(selectedProperty)) return
    const ownerId = owners[selectedProperty.id]
    const level = propertyLevels[selectedProperty.id] ?? 0
    const upgradeDiscount = playerEffects[activePlayer.id]?.upgradeDiscount ?? 0
    const upgradeCost = Math.max(50, getUpgradeCost(selectedProperty) - upgradeDiscount)
    const ownsMonopoly = Boolean(selectedProperty.group && completedGroups[selectedProperty.group]?.id === ownerId)
    const groupWasUpgraded = Boolean(
      selectedProperty.group && upgradedGroupsThisTurn.includes(selectedProperty.group),
    )

    if (
      ownerId !== activePlayer.id ||
      !ownsMonopoly ||
      mortgagedPropertyIds.includes(selectedProperty.id) ||
      brandTiles.some(
        (tile) => tile.group === selectedProperty.group && mortgagedPropertyIds.includes(tile.id),
      ) ||
      !canUpgradePropertyEvenly(selectedProperty, propertyLevels) ||
      groupWasUpgraded ||
      level >= maxPropertyLevel ||
      activePlayer.money < upgradeCost
    ) {
      return
    }

    setPropertyLevels((items) => ({ ...items, [selectedProperty.id]: level + 1 }))
    if (upgradeDiscount > 0) {
      setPlayerEffects((items) => ({
        ...items,
        [activePlayer.id]: { ...items[activePlayer.id], upgradeDiscount: 0 },
      }))
    }
    if (selectedProperty.group) {
      setUpgradedGroupsThisTurn((groups) => [...groups, selectedProperty.group as string])
    }
    applyMoneyDeltas({ [activePlayer.id]: -upgradeCost })
    setLogs((items) => [
      ...items,
      createLog(
        `${activePlayer.name} улучшает ${selectedProperty.name} до уровня ${level + 1} за ${money(upgradeCost)}`,
        activePlayer.id,
        'upgrade',
        -upgradeCost,
      ),
    ])
  }

  const sellSelectedPropertyStar = () => {
    if (!canActNow() || !selectedProperty) return
    const level = propertyLevels[selectedProperty.id] ?? 0
    if (
      owners[selectedProperty.id] !== activePlayer.id ||
      level <= 0 ||
      !canSellPropertyStarEvenly(selectedProperty, propertyLevels)
    ) return

    const saleValue = getStarSaleValue(selectedProperty)
    setPropertyLevels((items) => ({ ...items, [selectedProperty.id]: level - 1 }))
    applyMoneyDeltas({ [activePlayer.id]: saleValue })
    setLogs((items) => [
      ...items,
      createLog(
        `${activePlayer.name} продает звезду на ${selectedProperty.name} за ${money(saleValue)}`,
        activePlayer.id,
        'mortgage',
        saleValue,
      ),
    ])
  }

  const toggleSelectedPropertyMortgage = () => {
    if (!canActNow() || !selectedProperty || owners[selectedProperty.id] !== activePlayer.id) return
    const isMortgaged = mortgagedPropertyIds.includes(selectedProperty.id)

    if (isMortgaged) {
      const redemptionCost = getRedemptionCost(selectedProperty)
      if (activePlayer.money < redemptionCost) return

      setMortgagedPropertyIds((ids) => ids.filter((id) => id !== selectedProperty.id))
      setMortgageExpiryTurns((items) => {
        const next = { ...items }
        delete next[selectedProperty.id]
        return next
      })
      applyMoneyDeltas({ [activePlayer.id]: -redemptionCost })
      setLogs((items) => [
        ...items,
        createLog(
          `${activePlayer.name} выкупает ${selectedProperty.name} за ${money(redemptionCost)}`,
          activePlayer.id,
          'mortgage',
          -redemptionCost,
        ),
      ])
      return
    }

    if (!canMortgageProperty(selectedProperty, propertyLevels)) return

    const mortgageValue = getMortgageValue(selectedProperty)
    setMortgagedPropertyIds((ids) => [...ids, selectedProperty.id])
    setMortgageExpiryTurns((items) => ({
      ...items,
      [selectedProperty.id]: turnSequence + 15,
    }))
    applyMoneyDeltas({ [activePlayer.id]: mortgageValue })
    setLogs((items) => [
      ...items,
      createLog(
        `${activePlayer.name} закладывает ${selectedProperty.name} и получает ${money(mortgageValue)}`,
        activePlayer.id,
        'mortgage',
        mortgageValue,
      ),
    ])
  }

  const animatePlayerDirectly = async (
    playerId: string,
    startPosition: number,
    destinationPosition: number,
    speedMultiplier = 1,
  ) => {
    movingPlayerIdRef.current = playerId
    movementDestinationRef.current = destinationPosition
    setMovingPlayerId(playerId)
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

      const board = boardRef.current
      const player = players.find((item) => item.id === playerId)
      const startTile = board?.querySelector<HTMLElement>(`[data-tile-id="${startPosition}"]`)
      const destinationTile = board?.querySelector<HTMLElement>(`[data-tile-id="${destinationPosition}"]`)

      if (board && player && startTile && destinationTile) {
        const start = {
          x: startTile.offsetLeft + startTile.offsetWidth / 2,
          y: startTile.offsetTop + startTile.offsetHeight / 2,
        }
        const destination = {
          x: destinationTile.offsetLeft + destinationTile.offsetWidth / 2,
          y: destinationTile.offsetTop + destinationTile.offsetHeight / 2,
        }
        const travelDistance = distanceBetween(start, destination)
        let flyingToken = movingTokenRef.current
        for (let frame = 0; !flyingToken && frame < 10; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          flyingToken = movingTokenRef.current
        }
        if (!flyingToken) return

        const startTransform = `translate(${start.x - movementTokenRadius}px, ${start.y - movementTokenRadius}px) scale(1.08)`
        const destinationTransform = `translate(${destination.x - movementTokenRadius}px, ${destination.y - movementTokenRadius}px) scale(1.08)`
        flyingToken.style.transform = startTransform
        flyingToken.style.opacity = '1'

        const animation = flyingToken.animate(
          [
            { transform: startTransform },
            { transform: destinationTransform },
          ],
          {
            duration: Math.max(400, travelDistance / (movementPixelsPerMillisecond * speedMultiplier)),
            easing: 'linear',
            fill: 'forwards',
          },
        )

        try {
          await animation.finished
        } catch {
          // Resize/unmount can cancel a Web Animation; the game still finishes the move.
        } finally {
          flyingToken.style.transform = destinationTransform
          animation.cancel()
        }
      }
    } finally {
      if (movingPlayerIdRef.current === playerId) {
        const destination = movementDestinationRef.current
        if (destination !== null) {
          setPlayers((items) => items.map((item) =>
            item.id === playerId ? { ...item, position: destination } : item))
        }
        movingPlayerIdRef.current = null
        movementDestinationRef.current = null
        setMovingPlayerId(null)
      }
    }
  }

  const animatePlayerToJail = (playerId: string, startPosition: number) =>
    animatePlayerDirectly(playerId, startPosition, 10, 1.26)

  const updatePlayerEffect = (playerId: string, effect: Partial<PlayerEffects>) => {
    setPlayerEffects((items) => ({
      ...items,
      [playerId]: { ...items[playerId], ...effect },
    }))
  }

  const resolveDiamondEvent = async (player: Player, tile: Tile, extraRoll: boolean) => {
    const commonEvents = ['money', 'rent-discount'] as const
    const rareEvents = ['rent-surcharge', 'visitor', 'star', 'upgrade', 'lawyer'] as const
    const event = randomIntInclusive(1, 100) <= 75 ? pickRandom([...commonEvents]) : pickRandom([...rareEvents])

    if (event === 'money') {
      const amount = pickRandom([250, 500, 750, 1000])
      const isReward = randomIntInclusive(0, 1) === 1
      if (isReward) {
        applyMoneyDeltas({ [player.id]: amount })
        setLogs((items) => [...items, createLog(`Алмазик дарит ${player.name} ${money(amount)}`, player.id, 'diamond', amount)])
        completeTurn(extraRoll)
      } else {
        setLogs((items) => [...items, createLog(`Алмазик забирает у ${player.name} ${money(amount)}`, player.id, 'diamond')])
        startEventPaymentSequence([{ payerId: player.id, amount, tileId: tile.id, label: 'Алмазик' }])
      }
      return
    }

    if (event === 'rent-discount' || event === 'rent-surcharge') {
      const adjustment = event === 'rent-discount' ? -200 : 200
      updatePlayerEffect(player.id, { nextRentAdjustment: adjustment })
      setLogs((items) => [...items, createLog(
        event === 'rent-discount'
          ? `${player.name} получает скидку ${money(200)} на следующую аренду`
          : `${player.name} оплатит следующую аренду с переплатой ${money(200)}`,
        player.id,
        'diamond',
      )])
      completeTurn(extraRoll)
      return
    }

    if (event === 'visitor') {
      const adjustment = randomIntInclusive(0, 1) === 1 ? 300 : -300
      updatePlayerEffect(player.id, { nextVisitorAdjustment: adjustment })
      setLogs((items) => [...items, createLog(
        adjustment > 0
          ? `Следующий гость любого поля ${player.name} переплатит ${money(300)}`
          : `Следующий гость любого поля ${player.name} получит скидку ${money(300)}`,
        player.id,
        'diamond',
      )])
      completeTurn(extraRoll)
      return
    }

    if (event === 'upgrade') {
      updatePlayerEffect(player.id, { upgradeDiscount: 200 })
      setLogs((items) => [...items, createLog(`${player.name} сможет один раз улучшить поле дешевле на ${money(200)}`, player.id, 'diamond')])
      completeTurn(extraRoll)
      return
    }

    if (event === 'lawyer') {
      updatePlayerEffect(player.id, { freeJailRelease: true })
      setLogs((items) => [...items, createLog(`${player.name} знакомится с адвокатом и сможет один раз бесплатно выйти из тюрьмы`, player.id, 'diamond')])
      completeTurn(extraRoll)
      return
    }

    const addCandidates = brandTiles.filter((candidate) =>
      owners[candidate.id] === player.id &&
      isUpgradeableTile(candidate) &&
      Boolean(candidate.group && completedGroups[candidate.group]?.id === player.id) &&
      !mortgagedPropertyIds.includes(candidate.id) &&
      (propertyLevels[candidate.id] ?? 0) < maxPropertyLevel &&
      canUpgradePropertyEvenly(candidate, propertyLevels),
    )
    const removeCandidates = brandTiles.filter((candidate) =>
      owners[candidate.id] === player.id &&
      (propertyLevels[candidate.id] ?? 0) > 0 &&
      canSellPropertyStarEvenly(candidate, propertyLevels),
    )
    const shouldAdd = addCandidates.length > 0 && (removeCandidates.length === 0 || randomIntInclusive(0, 1) === 1)
    const candidates = shouldAdd ? addCandidates : removeCandidates
    const candidate = candidates.length > 0 ? pickRandom(candidates) : null

    if (!candidate) {
      applyMoneyDeltas({ [player.id]: 500 })
      setLogs((items) => [...items, createLog(`Алмазик не находит подходящего улучшения и дарит ${player.name} ${money(500)}`, player.id, 'diamond', 500)])
      completeTurn(extraRoll)
      return
    }

    const levelDelta = shouldAdd ? 1 : -1
    setPropertyLevels((items) => ({ ...items, [candidate.id]: (items[candidate.id] ?? 0) + levelDelta }))
    setLogs((items) => [...items, createLog(
      shouldAdd
        ? `Алмазик бесплатно улучшает ${candidate.name} игрока ${player.name}`
        : `Алмазик забирает одну звезду с ${candidate.name} игрока ${player.name}`,
      player.id,
      'diamond',
    )])
    completeTurn(extraRoll)
  }

  const resolveChanceEvent = async (player: Player, tile: Tile, extraRoll: boolean, diceTotal: number) => {
    const otherPlayers = players.filter((item) =>
      item.id !== player.id && !eliminatedPlayerIds.includes(item.id))
    const events = [
      'teleport', 'skip', 'reverse', 'tea', 'compliments', 'furniture',
      'invest-win', 'invest-loss', 'book-money', 'shopping', 'business',
      ...(tile.id === 38 ? [] : ['book-challenge']),
    ] as const
    const event = pickRandom(events)

    const reward = (amount: number, text: string) => {
      applyMoneyDeltas({ [player.id]: amount })
      setLogs((items) => [...items, createLog(text, player.id, 'chance', amount)])
      completeTurn(extraRoll)
    }
    const charge = (amount: number, text: string) => {
      setLogs((items) => [...items, createLog(text, player.id, 'chance')])
      startEventPaymentSequence([{ payerId: player.id, amount, tileId: tile.id, label: 'Вопросик' }])
    }

    if (event === 'teleport') {
      const destination = pickRandom(tiles.filter((candidate) => candidate.id !== tile.id))
      setLogs((items) => [
        ...items,
        createLog(
          `${player.name} телепортируется на ${destination.name}`,
          player.id,
          'chance',
        ),
      ])
      sendOnlineGameEvent?.({
        kind: 'direct-movement',
        playerId: player.id,
        startPosition: tile.id,
        destinationPosition: destination.id,
        speedMultiplier: 1.15,
      })
      await animatePlayerDirectly(player.id, tile.id, destination.id, 1.15)
      setPlayers((items) => items.map((item) => item.id === player.id ? { ...item, position: destination.id } : item))
      const teleportedPlayer = {
        ...player,
        position: destination.id,
      }
      if (destination.type === 'brand') {
        await resolveLanding(teleportedPlayer, destination, extraRoll, diceTotal, true)
      } else {
        completeTurn(extraRoll)
      }
      return
    }

    if (event === 'skip') {
      const reason = pickRandom([
        'пошёл играть в CS', 'пошёл играть в Dota 2', 'пошёл играть в Minecraft',
        'пошёл играть в Genshin Impact', 'пошёл играть в PUBG', 'пошёл играть в Танки',
        'пошёл играть в GTA 6', 'уснул за столом', 'пошёл смотреть стримы на Twitch', 'решил заняться спортом',
      ])
      updatePlayerEffect(player.id, { skipTurns: (playerEffects[player.id]?.skipTurns ?? 0) + 1 })
      setLogs((items) => [...items, createLog(`${player.name} ${reason} и пропустит следующий ход`, player.id, 'chance')])
      completeTurn(extraRoll)
      return
    }
    if (event === 'reverse') {
      updatePlayerEffect(player.id, { reverseNextRoll: true })
      setLogs((items) => [...items, createLog(`${player.name} следующий ход сделает в обратном направлении`, player.id, 'chance')])
      completeTurn(extraRoll)
      return
    }
    if (event === 'tea') {
      const recipient = otherPlayers.length ? pickRandom(otherPlayers) : null
      if (recipient) {
        setLogs((items) => [...items, createLog(`${player.name} оставляет ${recipient.name} на чай ${money(100)}`, player.id, 'chance')])
        startEventPaymentSequence([{ payerId: player.id, recipientId: recipient.id, amount: 100, tileId: tile.id, label: 'Чаевые' }])
      } else completeTurn(extraRoll)
      return
    }
    if (event === 'compliments' || event === 'business') {
      const amount = event === 'compliments' ? 300 : 100
      const contributions = otherPlayers.map((payer) => ({
        payer,
        amount: Math.max(0, Math.min(amount, payer.money)),
      }))
      const received = contributions.reduce((total, item) => total + item.amount, 0)
      applyMoneyDeltas(Object.fromEntries([
        ...contributions.map(({ payer, amount: contribution }) => [payer.id, -contribution] as const),
        [player.id, received],
      ]))
      setLogs((items) => [...items, createLog(
        event === 'compliments'
          ? `${player.name} получает от остальных игроков ${money(received)} за комплименты`
          : `${player.name} собирает ${money(received)} инвестиций в свой бизнес`,
        player.id,
        'chance',
        received,
      )])
      completeTurn(extraRoll)
      return
    }
    if (event === 'furniture') {
      const amount = randomMoneyByTen(100, 990)
      return charge(amount, `${player.name} обновляет мебель в офисе за ${money(amount)}`)
    }
    if (event === 'invest-win') {
      const amount = randomMoneyByTen(200, 800)
      return reward(amount, `${player.name} удачно инвестирует на бирже и получает ${money(amount)}`)
    }
    if (event === 'invest-loss') {
      const amount = randomMoneyByTen(200, 800)
      return charge(amount, `${player.name} неудачно инвестирует на бирже и теряет ${money(amount)}`)
    }
    if (event === 'book-money') return reward(250, `${player.name} читает «Богатый папа, бедный папа» и получает ${money(250)}`)
    if (event === 'shopping') {
      const amount = randomMoneyByTen(200, 500)
      return charge(amount, `${player.name} закупается в интернете на ${money(amount)}`)
    }
    if (event === 'book-challenge') {
      updatePlayerEffect(player.id, { bookChallenge: true })
      setLogs((items) => [...items, createLog(`${player.name} получит ${money(500)}, если дойдёт до старта, не потратив денег`, player.id, 'chance')])
      completeTurn(extraRoll)
      return
    }

    completeTurn(extraRoll)
  }

  const resolveTaxEvent = (player: Player, tile: Tile) => {
    const ownedTiles = brandTiles.filter((candidate) => owners[candidate.id] === player.id)
    const smallStars = ownedTiles.reduce((total, candidate) => {
      const level = propertyLevels[candidate.id] ?? 0
      return total + (level === maxPropertyLevel ? 0 : level)
    }, 0)
    const allStars = ownedTiles.filter((candidate) => (propertyLevels[candidate.id] ?? 0) === maxPropertyLevel).length
    const availableEvents = [
      'regular',
      ...(smallStars > 0 || allStars > 0 ? ['shareholders'] : []),
      ...(ownedTiles.length > 0 ? ['accounting'] : []),
    ] as const
    const event = pickRandom(availableEvents)
    const amount = event === 'shareholders'
      ? smallStars * 250 + allStars * 1000
      : event === 'accounting'
        ? ownedTiles.length * 100
        : randomMoneyByTen(100, 700)
    const description = event === 'shareholders'
      ? `${player.name} должен отдать акционерам ${money(amount)} за ${smallStars} малых и ${allStars} больших звёзд`
      : event === 'accounting'
        ? `Бухгалтерия ошиблась: ${player.name} должен заплатить по ${money(100)} за каждое из ${ownedTiles.length} полей`
        : `Банк начисляет ${player.name} налог ${money(amount)}`

    setLogs((items) => [...items, createLog(description, player.id, 'tax')])
    setPendingPayment({ payerId: player.id, amount, tileId: tile.id, kind: 'tax' })
  }

  const resolveLanding = async (
    player: Player,
    tile: Tile,
    extraRoll: boolean,
    diceTotal: number,
    fromTeleport = false,
  ) => {
    if (tile.type === 'brand') {
      const ownerId = owners[tile.id]

      if (!ownerId) {
        setPendingTileId(tile.id)
        setLogs((items) => [
          ...items,
          createLog(
            isSubscriptionTile(tile)
              ? `${player.name} выбирает подписку ${tile.name} и думает, стоит ли её оформить`
              : `${player.name} попадает на ${tile.name} и думает о покупке`,
            player.id,
            'thinking-buy',
          ),
        ])
        return
      }

      if (ownerId !== player.id) {
        if (mortgagedPropertyIds.includes(tile.id)) {
          setLogs((items) => [
            ...items,
            createLog(`${player.name} попадает на заложенное поле ${tile.name} и не платит аренду`, player.id, 'move'),
          ])
          completeTurn(extraRoll)
          return
        }

        const owner = players.find((item) => item.id === ownerId)
        const ownedSubscriptionCount = subscriptionTiles.filter((item) => owners[item.id] === ownerId).length
        const subscriptionMultiplier = subscriptionRentMultipliers[Math.min(ownedSubscriptionCount, 2) - 1] ?? 100
        const ownedFleetCount = fleetTiles.filter((item) => owners[item.id] === ownerId).length
        const fleetRent = fleetRentLevels[Math.min(ownedFleetCount, 4) - 1] ?? fleetRentLevels[0]
        const baseRent = isSubscriptionTile(tile)
          ? diceTotal * subscriptionMultiplier
          : isFleetTile(tile)
            ? fleetRent
            : getRentAtLevel(tile, propertyLevels[tile.id] ?? 0)
        if (!owner) {
          completeTurn(extraRoll)
          return
        }

        const payerAdjustment = playerEffects[player.id]?.nextRentAdjustment ?? 0
        const ownerAdjustment = playerEffects[ownerId]?.nextVisitorAdjustment ?? 0
        const rent = Math.max(0, baseRent + payerAdjustment + ownerAdjustment)
        if (payerAdjustment !== 0 || ownerAdjustment !== 0) {
          setPlayerEffects((items) => ({
            ...items,
            [player.id]: { ...items[player.id], nextRentAdjustment: 0 },
            [ownerId]: { ...items[ownerId], nextVisitorAdjustment: 0 },
          }))
        }

        if (rent === 0) {
          setLogs((items) => [...items, createLog(`${player.name} полностью покрывает аренду скидкой и ничего не платит`, player.id, 'rent')])
          completeTurn(extraRoll)
          return
        }

        setPendingPayment({
          payerId: player.id,
          recipientId: ownerId,
          tileId: tile.id,
          amount: rent,
          kind: 'rent',
        })
        setLogs((items) => [
          ...items,
          createLog(
            isSubscriptionTile(tile)
              ? `${player.name} оформляет подписку ${tile.name} у ${owner.name}: ${diceTotal} × ${subscriptionMultiplier} = ${money(rent)}`
              : isFleetTile(tile)
                ? `${player.name} арендует автомобиль ${tile.name} у ${owner.name}: ${money(rent)}`
              : `${player.name} должен заплатить ${owner.name} аренду: ${money(rent)}`,
            player.id,
            'rent',
          ),
        ])
        return
      } else {
        setLogs((items) => [
          ...items,
          createLog(
            isSubscriptionTile(tile)
              ? `${player.name} пользуется своей подпиской ${tile.name}`
              : isFleetTile(tile)
                ? `${player.name} пользуется своим автомобилем ${tile.name}`
              : `${player.name} заходит на свое поле ${tile.name}`,
            player.id,
            'move',
          ),
        ])
      }
    }

    if (fromTeleport) {
      completeTurn(extraRoll)
      return
    }

    if (tile.type === 'chance') {
      setLogs((items) => [...items, createLog(`${player.name} попадает на поле «Шанс»`, player.id, 'move')])
      await resolveChanceEvent(player, tile, extraRoll, diceTotal)
      return
    }

    if (tile.type === 'diamond') {
      setLogs((items) => [...items, createLog(`${player.name} попадает на событие «Алмазик»`, player.id, 'move')])
      await resolveDiamondEvent(player, tile, extraRoll)
      return
    }

    if (tile.type === 'tax') {
      resolveTaxEvent(player, tile)
      return
    }

    if (tile.type === 'casino') {
      setCasino({ playerId: player.id, selectedNumbers: [] })
      setLogs((items) => [
        ...items,
        createLog(`${player.name} заходит в казино и выбирает числа для ставки`, player.id, 'jackpot'),
      ])
      return
    }

    if (tile.type === 'jail') {
      setLogs((items) => [...items, createLog(`${player.name} навещает тюрьму`, player.id, 'jail')])
    }

    if (tile.type === 'police') {
      sendOnlineGameEvent?.({
        kind: 'direct-movement',
        playerId: player.id,
        startPosition: tile.id,
        destinationPosition: 10,
        speedMultiplier: 1.26,
      })
      await animatePlayerToJail(player.id, tile.id)
      setPlayers((items) =>
        items.map((item) => (item.id === player.id ? { ...item, position: 10 } : item)),
      )
      setJailedPlayerIds((ids) => (ids.includes(player.id) ? ids : [...ids, player.id]))
      setJailFailedAttempts((items) => ({ ...items, [player.id]: 0 }))
      setHasExtraRoll(false)
      setLogs((items) => [
        ...items,
        createLog(`${player.name} арестован и отправляется в тюрьму`, player.id, 'jail'),
      ])
      completeTurn(false)
      return
    }

    completeTurn(extraRoll)
  }

  const animatePlayerMovement = async (
    playerId: string,
    startPosition: number,
    steps: number,
    direction: 1 | -1 = 1,
  ) => {
    const finalPosition = (startPosition + steps * direction + tiles.length) % tiles.length
    movingPlayerIdRef.current = playerId
    movementDestinationRef.current = finalPosition
    setMovingPlayerId(playerId)
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))

      const board = boardRef.current
      const player = players.find((item) => item.id === playerId)
      const route = Array.from(
        { length: steps + 1 },
        (_, index) => (startPosition + index * direction + tiles.length) % tiles.length,
      )
      const routePoints = route.flatMap((tileId) => {
        const tile = board?.querySelector<HTMLElement>(`[data-tile-id="${tileId}"]`)
        return tile ? [{ x: tile.offsetLeft + tile.offsetWidth / 2, y: tile.offsetTop + tile.offsetHeight / 2 }] : []
      })

      if (board && player && routePoints.length === route.length && routePoints.length > 1) {
        const points = smoothMovementPath(routePoints)
        const distances = points.slice(1).map((point, index) => distanceBetween(points[index], point))
        const totalDistance = distances.reduce((total, distance) => total + distance, 0)
        let travelledDistance = 0
        const offsets = [0, ...distances.map((distance) => {
          travelledDistance += distance
          return travelledDistance / totalDistance
        })]
        let flyingToken = movingTokenRef.current
        for (let frame = 0; !flyingToken && frame < 10; frame += 1) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
          flyingToken = movingTokenRef.current
        }
        if (!flyingToken) return

        const startPoint = points[0]
        const destinationPoint = points.at(-1)
        if (!startPoint || !destinationPoint) return
        const startTransform = `translate(${startPoint.x - movementTokenRadius}px, ${startPoint.y - movementTokenRadius}px) scale(1.08)`
        const destinationTransform = `translate(${destinationPoint.x - movementTokenRadius}px, ${destinationPoint.y - movementTokenRadius}px) scale(1.08)`
        flyingToken.style.transform = startTransform
        flyingToken.style.opacity = '1'

        const animation = flyingToken.animate(
          points.map((point, index) => ({
            transform: `translate(${point.x - movementTokenRadius}px, ${point.y - movementTokenRadius}px) scale(1.08)`,
            offset: offsets[index],
          })),
          {
            duration: Math.max(500, totalDistance / movementPixelsPerMillisecond),
            easing: 'linear',
            fill: 'forwards',
          },
        )

        try {
          await animation.finished
        } catch {
          // Resize/unmount can cancel a Web Animation; the game still finishes the move.
        } finally {
          flyingToken.style.transform = destinationTransform
          animation.cancel()
        }
      } else {
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, Math.max(500, steps * fallbackMovementDurationPerTile)),
        )
      }

    } finally {
      if (movingPlayerIdRef.current === playerId) {
        const destination = movementDestinationRef.current
        if (destination !== null) {
          setPlayers((items) => items.map((item) =>
            item.id === playerId ? { ...item, position: destination } : item))
        }
        movingPlayerIdRef.current = null
        movementDestinationRef.current = null
        setMovingPlayerId(null)
      }
    }
  }

  useEffect(() => {
    if (!onlineGameEvent) return
    const event = onlineGameEvent.event
    const eventId = onlineGameEvent.nonce
    const playEvent = async () => {
      try {
        if (event.kind === 'dice-roll') {
          await playDiceRollAnimation(event.dice)
        } else if (event.kind === 'movement') {
          await animatePlayerMovement(event.playerId, event.startPosition, event.steps, event.direction)
        } else {
          await animatePlayerDirectly(
            event.playerId,
            event.startPosition,
            event.destinationPosition,
            event.speedMultiplier,
          )
        }
      } finally {
        acknowledgeOnlineGameEvent?.(eventId)
      }
    }
    void playEvent()
    // The queue advances only after this animation finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineGameEvent?.nonce])

  const rollDice = async () => {
    if (!canActNow() || isRolling || pendingTile || pendingPayment || casino || auction || tradeDraft) return
    if (!serverForcedActionRef.current && turnDeadline && turnClockNow >= turnDeadline - 1000) return

    setSelectedPropertyId(null)
    setIsRolling(true)
    if (!serverForcedActionRef.current) beginOnlineTurnAction?.()
    const roll = await rollComplexDice()
    setLastRoll(roll)
    sendOnlineGameEvent?.({ kind: 'dice-roll', playerId: players[activePlayerIndex].id, dice: roll.dice })
    await playDiceRollAnimation(roll.dice)

    const player = players[activePlayerIndex]

    if (jailedPlayerIds.includes(player.id)) {
      if ((jailFailedAttempts[player.id] ?? 0) >= 3) {
        setIsRolling(false)
        return
      }

      const rolledDouble = roll.dice[0] === roll.dice[1]

      if (!rolledDouble) {
        const failedAttempts = (jailFailedAttempts[player.id] ?? 0) + 1
        setJailFailedAttempts((items) => ({ ...items, [player.id]: failedAttempts }))
        setLogs((items) => [
          ...items,
          createLog(
            `${player.name} пытается выйти из тюрьмы и выбрасывает ${roll.dice[0]}:${roll.dice[1]}`,
            player.id,
            'roll',
          ),
          createLog(
            failedAttempts >= 3
              ? `${player.name} третий раз не выбрасывает дубль — на следующем ходу должен выйти из тюрьмы`
              : `${player.name} не выбрасывает дубль и остается в тюрьме (${failedAttempts}/3)`,
            player.id,
            'jail',
          ),
        ])
        completeTurn(false)
        setIsRolling(false)
        return
      }

      const direction: 1 | -1 = playerEffects[player.id]?.reverseNextRoll ? -1 : 1
      const nextPosition = (10 + roll.total * direction + tiles.length) % tiles.length
      const landedTile = tiles[nextPosition]
      const releasedPlayer = { ...player, position: nextPosition }

      if (direction === -1) {
        updatePlayerEffect(player.id, { reverseNextRoll: false })
      }

      setJailedPlayerIds((ids) => ids.filter((id) => id !== player.id))
      setJailFailedAttempts((items) => {
        const next = { ...items }
        delete next[player.id]
        return next
      })
      setLogs((items) => [
        ...items,
        createLog(
          `${player.name} выбрасывает дубль ${roll.dice[0]}:${roll.dice[1]} и выходит из тюрьмы`,
          player.id,
          'jail',
        ),
      ])
      sendOnlineGameEvent?.({ kind: 'movement', playerId: player.id, startPosition: 10, steps: roll.total, direction })
      await animatePlayerMovement(player.id, 10, roll.total, direction)
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000))
      setLogs((items) => [
        ...items,
        createLog(`${player.name} проходит ${roll.total} клеток${direction === -1 ? ' назад' : ''} и попадает на ${landedTile.name}`, player.id, 'move'),
      ])
      await resolveLanding(releasedPlayer, landedTile, false, roll.total)
      setIsRolling(false)
      return
    }

    const previousPosition = player.position
    const direction: 1 | -1 = playerEffects[player.id]?.reverseNextRoll ? -1 : 1
    const nextPosition = (previousPosition + roll.total * direction + tiles.length) % tiles.length
    const passedStart = direction === 1 && previousPosition + roll.total >= tiles.length
    const completedLaps = lapCounts[player.id] ?? 0
    const completedLapNumber = completedLaps + 1
    const regularStartBonus = passedStart ? startBonusForLap(completedLapNumber) : 0
    const bookBonus = passedStart && playerEffects[player.id]?.bookChallenge ? 500 : 0
    const totalStartBonus = regularStartBonus + bookBonus
    const landedTile = tiles[nextPosition]
    const rolledDouble = roll.dice[0] === roll.dice[1]
    setHasExtraRoll(rolledDouble)

    const movedPlayer = {
      ...player,
      position: nextPosition,
      money: player.money + totalStartBonus,
      lastDelta: totalStartBonus > 0 ? totalStartBonus : player.lastDelta,
    }

    if (passedStart) {
      setLapCounts((items) => ({ ...items, [player.id]: completedLaps + 1 }))
    }
    if (direction === -1 || bookBonus > 0) {
      updatePlayerEffect(player.id, {
        ...(direction === -1 ? { reverseNextRoll: false } : {}),
        ...(bookBonus > 0 ? { bookChallenge: false } : {}),
      })
    }

    setLogs((items) => [
      ...items,
      createLog(
        `${player.name} выбрасывает ${roll.dice[0]}:${roll.dice[1]} через ${roll.samples.length} источников`,
        player.id,
        'roll',
      ),
      ...(rolledDouble
        ? [createLog(`${player.name} выбрасывает дубль и получает еще один бросок после расчета`, player.id, 'roll')]
        : []),
    ])

    sendOnlineGameEvent?.({
      kind: 'movement',
      playerId: player.id,
      startPosition: previousPosition,
      steps: roll.total,
      direction,
    })
    await animatePlayerMovement(player.id, previousPosition, roll.total, direction)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000))
    setPlayers((items) =>
      items.map((item) =>
        item.id === player.id
          ? {
              ...item,
              money: item.money + totalStartBonus,
              lastDelta: totalStartBonus > 0 ? totalStartBonus : item.lastDelta,
            }
          : item,
      ),
    )
    setLogs((items) => [
      ...items,
      ...(passedStart
        ? [createLog(
              regularStartBonus > 0
                ? `${player.name} проходит старт и получает ${money(regularStartBonus)}${bookBonus ? ` и книжный бонус ${money(bookBonus)}` : ''}`
                : `${player.name} проходит старт после 40 оплаченных кругов без награды${bookBonus ? `, но получает книжный бонус ${money(bookBonus)}` : ''}`,
            player.id,
            'rent',
            totalStartBonus || undefined,
          )]
        : []),
      createLog(`${player.name} проходит ${roll.total} клеток${direction === -1 ? ' назад' : ''} и попадает на ${landedTile.name}`, player.id, 'move'),
    ])

    await resolveLanding(movedPlayer, landedTile, rolledDouble, roll.total)
    setIsRolling(false)
  }

  const buyPendingTile = () => {
    if (!canActNow() || !pendingTile || pendingTile.type !== 'brand' || !activePlayer) return

    const price = pendingTile.price ?? 0
    if (activePlayer.money < price) return

    setOwners((items) => ({ ...items, [pendingTile.id]: activePlayer.id }))
    applyMoneyDeltas({ [activePlayer.id]: -price })
    setLogs((items) => [
      ...items,
      createLog(
        isSubscriptionTile(pendingTile)
          ? `${activePlayer.name} оформляет подписку ${pendingTile.name} за ${money(price)}`
          : `${activePlayer.name} покупает ${pendingTile.name} за ${money(price)}`,
        activePlayer.id,
        'buy',
        -price,
      ),
    ])
    setSelectedPropertyId(null)
    setPendingTileId(null)
    completeTurn()
  }

  const skipPurchase = () => {
    if (!canActNow() || !pendingTile) return
    const startingPrice = pendingTile.price ?? 0
    const participantIds = players
      .filter((player) =>
        player.id !== activePlayer.id &&
        !eliminatedPlayerIds.includes(player.id) &&
        player.money >= startingPrice + auctionIncrement)
      .map((player) => player.id)

    if (participantIds.length === 0) {
      setLogs((items) => [
        ...items,
        createLog(`На аукцион ${pendingTile.name} не нашлось участников`, activePlayer.id, 'auction'),
      ])
      setPendingTileId(null)
      completeTurn()
      return
    }

    const firstBidder = nextParticipant(participantIds, activePlayer.id, participantIds)
    setLogs((items) => [
      ...items,
      createLog(`${activePlayer.name} выставляет ${pendingTile.name} на общий аукцион`, activePlayer.id, 'auction'),
    ])
    setAuction({
      tileId: pendingTile.id,
      participantIds,
      activeBidderId: firstBidder,
      currentBid: startingPrice,
      highestBidderId: null,
      passedIds: [],
    })
    setAuctionBid(String(auctionIncrement))
    setPendingTileId(null)
  }

  const autoResolveTimedPayment = () => {
    if (!pendingPayment) return
    const payer = players.find((player) => player.id === pendingPayment.payerId)
    const recipient = pendingPayment.recipientId
      ? players.find((player) => player.id === pendingPayment.recipientId)
      : null
    if (!payer) return
    if (payer.money >= pendingPayment.amount) {
      payPendingRent()
      return
    }
    if (getPlayerMaximumCash(payer.id) < pendingPayment.amount) {
      surrenderPlayer(payer.id)
      return
    }

    let raised = 0
    const required = pendingPayment.amount - payer.money
    const nextLevels = { ...propertyLevels }
    const nextMortgagedIds = [...mortgagedPropertyIds]
    const nextExpiry = { ...mortgageExpiryTurns }
    const ownedTiles = brandTiles.filter((tile) => owners[tile.id] === payer.id)

    for (const tile of ownedTiles) {
      while ((nextLevels[tile.id] ?? 0) > 0 && raised < required) {
        nextLevels[tile.id] -= 1
        raised += getStarSaleValue(tile)
      }
    }
    for (const tile of ownedTiles) {
      if (raised >= required) break
      if (!canMortgageProperty(tile, nextLevels) || nextMortgagedIds.includes(tile.id)) continue
      nextMortgagedIds.push(tile.id)
      nextExpiry[tile.id] = turnSequence + 15
      raised += getMortgageValue(tile)
    }

    setPropertyLevels(nextLevels)
    setMortgagedPropertyIds(nextMortgagedIds)
    setMortgageExpiryTurns(nextExpiry)
    applyMoneyDeltas({
      [payer.id]: raised - pendingPayment.amount,
      ...(recipient ? { [recipient.id]: pendingPayment.amount } : {}),
    })
    setLogs((items) => [
      ...items,
      createLog(`${payer.name} автоматически продаёт улучшения и закладывает поля`, payer.id, 'mortgage', raised),
      createLog(
        pendingPayment.kind === 'rent'
          ? `${payer.name} автоматически платит аренду ${recipient?.name ?? 'владельцу'}: ${money(pendingPayment.amount)}`
          : pendingPayment.kind === 'tax'
            ? `${payer.name} автоматически платит налог банку: ${money(pendingPayment.amount)}`
            : `${payer.name} автоматически оплачивает событие: ${money(pendingPayment.amount)}`,
        payer.id,
        pendingPayment.kind === 'event' ? 'chance' : pendingPayment.kind,
        -pendingPayment.amount,
      ),
    ])

    if (pendingPayment.kind === 'event' && eventPaymentQueue.length > 0) {
      const [nextPayment, ...remainingPayments] = eventPaymentQueue
      setEventPaymentQueue(remainingPayments)
      setPendingPayment({ ...nextPayment, kind: 'event', eventLabel: nextPayment.label })
    } else {
      setEventPaymentQueue([])
      setPendingPayment(null)
      completeTurn()
    }
  }

  const autoReleaseFromJail = () => {
    if (playerEffects[activePlayer.id]?.freeJailRelease || activePlayer.money >= jailReleaseCost) {
      payJailRelease()
      return
    }
    if (getPlayerMaximumCash(activePlayer.id) < jailReleaseCost) {
      surrenderPlayer(activePlayer.id)
      return
    }

    let raised = 0
    const required = jailReleaseCost - activePlayer.money
    const nextLevels = { ...propertyLevels }
    const nextMortgagedIds = [...mortgagedPropertyIds]
    const nextExpiry = { ...mortgageExpiryTurns }
    const ownedTiles = brandTiles.filter((tile) => owners[tile.id] === activePlayer.id)
    for (const tile of ownedTiles) {
      while ((nextLevels[tile.id] ?? 0) > 0 && raised < required) {
        nextLevels[tile.id] -= 1
        raised += getStarSaleValue(tile)
      }
    }
    for (const tile of ownedTiles) {
      if (raised >= required) break
      if (!canMortgageProperty(tile, nextLevels) || nextMortgagedIds.includes(tile.id)) continue
      nextMortgagedIds.push(tile.id)
      nextExpiry[tile.id] = turnSequence + 15
      raised += getMortgageValue(tile)
    }
    setPropertyLevels(nextLevels)
    setMortgagedPropertyIds(nextMortgagedIds)
    setMortgageExpiryTurns(nextExpiry)
    applyMoneyDeltas({ [activePlayer.id]: raised - jailReleaseCost })
    setJailedPlayerIds((ids) => ids.filter((id) => id !== activePlayer.id))
    setJailFailedAttempts((items) => {
      const next = { ...items }
      delete next[activePlayer.id]
      return next
    })
    setLogs((items) => [
      ...items,
      createLog(`${activePlayer.name} автоматически получает ${money(raised)} за активы`, activePlayer.id, 'mortgage', raised),
      createLog(`${activePlayer.name} оплачивает обязательный выход из тюрьмы: ${money(jailReleaseCost)}`, activePlayer.id, 'jail', -jailReleaseCost),
    ])
  }

  useEffect(() => {
    if (!turnTimeoutSignal || handledTimeoutIdsRef.current.has(turnTimeoutSignal.timeoutId)) return
    handledTimeoutIdsRef.current.add(turnTimeoutSignal.timeoutId)
    if (handledTimeoutIdsRef.current.size > 100) {
      const oldestTimeoutId = handledTimeoutIdsRef.current.values().next().value
      if (oldestTimeoutId) handledTimeoutIdsRef.current.delete(oldestTimeoutId)
    }
    const timer = window.setTimeout(() => {
      const handleTimeout = async () => {
        serverForcedActionRef.current = true
        suspendOnlinePublishRef.current = true
        forcedOnlinePublishRef.current = true
        try {
          const countsAsMissedTurn = !auction && !tradeDraft && onlineDecisionPlayerId === activePlayer.id
          const nextMissedTurns = (missedTurnCounts[activePlayer.id] ?? 0) + 1
          if (countsAsMissedTurn) {
            setMissedTurnCounts((items) => ({ ...items, [activePlayer.id]: nextMissedTurns }))
          }
          if (countsAsMissedTurn && nextMissedTurns >= 3) {
            setLogs((items) => [
              ...items,
              createLog(`${activePlayer.name} пропускает третий ход и выбывает`, activePlayer.id, 'bankruptcy'),
            ])
            surrenderPlayer(activePlayer.id)
          } else if (pendingPayment) autoResolveTimedPayment()
          else if (pendingTile) skipPurchase()
          else if (auction) passAuction()
          else if (casino) declineCasino()
          else if (tradeDraft) closeSharedTrade()
          else if (isActivePlayerJailed && isForcedJailRelease) {
            autoReleaseFromJail()
          } else {
            setLogs((items) => [
              ...items,
              createLog(`${activePlayer.name} не успевает бросить кубики — выполняется автоматический бросок`, activePlayer.id, 'system'),
            ])
            await rollDice()
          }
        } finally {
          serverForcedActionRef.current = false
          suspendOnlinePublishRef.current = false
          setForcedPublishTick((tick) => tick + 1)
        }
      }
      void handleTimeout()
    }, 0)
    return () => window.clearTimeout(timer)
    // The server signal is the sole trigger; gameplay values are intentionally read from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnTimeoutSignal])

  const sendMessage = () => {
    const text = message.trim().slice(0, 256)
    if (!text) return
    const localPlayer = localPlayerId ? players.find((player) => player.id === localPlayerId) : activePlayer
    if (!localPlayer) return
    if (sendOnlineChat) sendOnlineChat(text)
    else setLogs((items) => [...items, createLog(`${localPlayer.name}: ${text}`, localPlayer.id, 'chat')])
    setMessage('')
  }

  return (
    <GameViewport>
      {winnerId ? (
        <section className="winner-overlay" aria-live="polite">
          <small>Игра окончена</small>
          <h1>{players.find((player) => player.id === winnerId)?.name ?? 'Игрок'} побеждает!</h1>
          <p>Возвращаемся в лобби…</p>
        </section>
      ) : null}
      {settingsOpen ? (
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>Интерфейс</small>
                <h2 id="settings-title">Настройки</h2>
              </div>
              <button type="button" className="settings-close" onClick={() => setSettingsOpen(false)} aria-label="Закрыть">×</button>
            </header>
            <div className="settings-row">
              <div>
                <strong>Минималистичный чат</strong>
                <span>Без иконок и отдельных карточек.</span>
              </div>
              <button
                type="button"
                className={`settings-switch ${minimalistChat ? 'enabled' : ''}`}
                role="switch"
                aria-checked={minimalistChat}
                onClick={() => setMinimalistChat((enabled) => {
                  const nextValue = !enabled
                  try {
                    window.localStorage.setItem(minimalistChatStorageKey, nextValue ? 'enabled' : 'disabled')
                  } catch {
                    // The setting still works for this tab if storage is unavailable.
                  }
                  return nextValue
                })}
              >
                <span />
              </button>
            </div>
          </section>
        </div>
      ) : null}
      <aside className="players-panel" aria-label="Игроки">
        <div className="panel-title">Игроки ({players.length})</div>

        {players.map((player, index) => {
          const isActive = index === activePlayerIndex
          const isDecisionPlayer = player.id === onlineDecisionPlayerId
          const isEliminated = eliminatedPlayerIds.includes(player.id)
          const isDisconnected = disconnectedPlayerIds.includes(player.id)
          const delta = player.lastDelta ?? 0
          const missedTurns = missedTurnCounts[player.id] ?? 0

          const canOpenSurrender = player.id === activePlayer.id && (!localPlayerId || localPlayerId === player.id)
          const canOpenTrade = player.id !== activePlayer.id && canLocalPlayerAct && tradeRequestsThisTurn < maxTradeRequestsPerTurn
          const canInteractWithPlayer = !isEliminated && (canOpenSurrender || canOpenTrade)
          const isInteractionOpen = interactionPlayerId === player.id &&
            !canLocalPlayerSeeTrade &&
            canInteractWithPlayer

          return (
            <div
              className={`player-entry ${isInteractionOpen ? 'interaction-open' : ''}`}
              key={player.id}
              onMouseEnter={() => startOwnerPreview(player.id)}
              onMouseLeave={stopOwnerPreview}
            >
              <article
                className={`player-card ${isActive && !isEliminated ? 'active' : ''} ${isEliminated ? 'eliminated' : ''} ${isDisconnected ? 'disconnected' : ''} ${previewedPlayerId === player.id ? 'previewing' : ''}`}
                style={{ '--player-color': player.color } as CSSProperties}
                role={canInteractWithPlayer ? 'button' : undefined}
                tabIndex={canInteractWithPlayer ? 0 : undefined}
                aria-expanded={isInteractionOpen}
                onFocus={() => startOwnerPreview(player.id)}
                onBlur={stopOwnerPreview}
                onClick={() => openPlayerInteraction(player.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openPlayerInteraction(player.id)
                  }
                }}
              >
                <span className="player-laps" title="Пройдено кругов">Кругов: {lapCounts[player.id] ?? 0}</span>
                <div className="avatar-wrap">
                  <div className="avatar">{player.avatar}</div>
                  {isEliminated ? (
                    <span className="level-dot">☠</span>
                  ) : isDecisionPlayer && !(isRolling && player.id === activePlayer.id) ? (
                    <span className="level-dot">{secondsLeft}</span>
                  ) : null}
                </div>
                <div className="player-info">
                  <strong>{player.name}</strong>
                  <span className="player-state">
                    <i />
                    {isEliminated ? 'Проиграл' : isDisconnected ? 'Не в сети' : jailedPlayerIds.includes(player.id) ? 'В тюрьме' : isActive ? 'Ходит' : 'Ждет'}
                  </span>
                  <span className="player-money">{money(player.money)}</span>
                  <span className={`player-delta ${delta > 0 ? 'positive' : ''} ${delta < 0 ? 'negative' : ''}`}>
                    {deltaMoney(delta)}
                  </span>
                  {missedTurns > 0 && !isEliminated ? (
                    <span className="missed-turns">Пропуски: {missedTurns}/3</span>
                  ) : null}
                  {isActive && canLocalPlayerAct ? (
                    <span className="trade-request-count">Обмены: {tradeRequestsThisTurn}/{maxTradeRequestsPerTurn}</span>
                  ) : null}
                  {playerEffects[player.id] && Object.values(playerEffects[player.id]).some(Boolean) ? (
                    <span className="player-effects" aria-label="Активные эффекты">
                      {playerEffects[player.id]?.nextRentAdjustment ? <i>Аренда {deltaMoney(playerEffects[player.id].nextRentAdjustment)}</i> : null}
                      {playerEffects[player.id]?.nextVisitorAdjustment ? <i>Гость {deltaMoney(playerEffects[player.id].nextVisitorAdjustment)}</i> : null}
                      {playerEffects[player.id]?.upgradeDiscount ? <i>Улучшение −{money(playerEffects[player.id].upgradeDiscount ?? 0)}</i> : null}
                      {playerEffects[player.id]?.freeJailRelease ? <i>Адвокат</i> : null}
                      {playerEffects[player.id]?.reverseNextRoll ? <i>Ход назад</i> : null}
                      {playerEffects[player.id]?.skipTurns ? <i>Пропуск хода</i> : null}
                      {playerEffects[player.id]?.bookChallenge ? <i>Книжный бонус</i> : null}
                    </span>
                  ) : null}
                </div>
              </article>

              {isInteractionOpen && !isEliminated ? (
                <section
                  className="player-interaction-menu"
                  aria-label={`Действия с игроком ${player.name}`}
                  style={{ '--player-color': player.color } as CSSProperties}
                >
                  {canOpenSurrender ? (
                    <button
                      type="button"
                      className="interaction-menu-button surrender-menu-button"
                      onClick={() => surrenderPlayer(player.id)}
                      disabled={players.length <= 1}
                    >
                      <span aria-hidden="true">×</span>
                      Сдаться
                    </button>
                  ) : canOpenTrade ? (
                    <button
                      type="button"
                      className="interaction-menu-button"
                      onClick={() => beginTrade(player.id)}
                    >
                      <span aria-hidden="true">↔</span>
                      Обмен
                    </button>
                  ) : null}
                </section>
              ) : null}
            </div>
          )
        })}

        <div className="side-actions">
          <button type="button" className="quiet-button settings-button" onClick={() => setSettingsOpen(true)}>
            Настройки
          </button>
        </div>

      </aside>

      <section className="board-wrap" aria-label="Игровое поле">
        <div className="board" ref={boardRef}>
          {tiles.map((tile) => {
            const owner = owners[tile.id]
            const ownerPlayer = players.find((player) => player.id === owner)
            const tilePlayers = playersByTile[tile.id] ?? []
            const jailedTilePlayers =
              tile.type === 'jail'
                ? tilePlayers.filter((player) => jailedPlayerIds.includes(player.id)).slice(0, 3)
                : []
            const visibleTilePlayers =
              tile.type === 'jail'
                ? tilePlayers.filter((player) => !jailedPlayerIds.includes(player.id))
                : tilePlayers
            const propertyLevel = propertyLevels[tile.id] ?? 0
            const currentRent = getRentAtLevel(tile, propertyLevel)
            const ownedSubscriptionCount = owner ? subscriptionCountsByOwner[owner] ?? 0 : 0
            const subscriptionMultiplier =
              subscriptionRentMultipliers[Math.min(ownedSubscriptionCount, 2) - 1] ?? 100
            const ownedFleetCount = owner ? fleetTiles.filter((item) => owners[item.id] === owner).length : 0
            const fleetRent = fleetRentLevels[Math.min(ownedFleetCount, 4) - 1] ?? fleetRentLevels[0]
            const isMortgaged = mortgagedPropertyIds.includes(tile.id)
            const isPendingPaymentTile = pendingPayment?.tileId === tile.id
            const isActivePlayerTile = activePlayer.position === tile.id && movingPlayerId !== activePlayer.id
            const tradeHistoryColor = tradeHistoryPreview[tile.id]
            const isSelectedProperty = selectedPropertyId === tile.id || pendingTile?.id === tile.id
            const isGroupPreview = Boolean(tile.group && hoveredGroup === tile.group)
            const side = getTileSide(tile.id)
            const isCorner = side === 'corner'
            const isLabeledEvent = tile.type === 'chance' || tile.type === 'tax' || tile.type === 'diamond'
            const tradeSelectionSide = canLocalPlayerEditTradeDraft && tradeDraft
              ? owner === activePlayer.id
                ? 'offered'
                : owner === tradeTarget?.id
                  ? 'requested'
                  : null
              : null
            const tradeDisplaySide = tradeDraft?.offeredTileIds.includes(tile.id)
              ? 'offered'
              : tradeDraft?.requestedTileIds.includes(tile.id)
                ? 'requested'
                : null
            const isTradeSelected = tradeDisplaySide !== null
            const tradeColorSide = tradeDisplaySide ?? tradeSelectionSide
            const style = {
              ...tilePosition(tile.id),
              '--tile-tone': getTileTone(tile),
              '--owner-color': ownerPlayer?.color ?? 'transparent',
              '--trade-color':
                tradeColorSide === 'offered' ? activePlayer.color : tradeTarget?.color ?? 'transparent',
              '--trade-history-color': tradeHistoryColor ?? 'transparent',
              '--selected-tile-color': getTileTone(tile),
              '--group-preview-color': tile.group ? groupColors[tile.group] : 'transparent',
              '--active-player-color': activePlayer.color,
            } as CSSProperties

            const openTile = () => {
              if (tile.type !== 'brand') return
              if (tradeDraft?.stage === 'review') return

              if (canLocalPlayerEditTradeDraft && tradeSelectionSide) {
                toggleTradeTile(tradeSelectionSide, tile.id)
                return
              }

              setInteractionPlayerId(null)
              setSelectedPropertyId(tile.id)
            }

            return (
              <div
                className={`tile ${tile.type} side-${side} ${isCorner ? 'corner' : ''} ${owner ? 'owned' : ''} ${isMortgaged ? 'mortgaged' : ''} ${isPendingPaymentTile ? 'payment-due' : ''} ${isActivePlayerTile ? 'active-player-tile' : ''} ${owner && hoveredOwnerId === owner ? 'owner-preview' : ''} ${tradeHistoryColor ? 'trade-history-preview' : ''} ${isSelectedProperty ? 'selected-property' : ''} ${isGroupPreview ? 'group-preview' : ''} ${tradeSelectionSide ? 'trade-selectable' : ''} ${isTradeSelected ? `trade-selected trade-${tradeDisplaySide}` : ''} image-${tile.imageMode ?? 'contain'}`}
                key={tile.id}
                data-tile-id={tile.id}
                style={style}
                role={tile.type === 'brand' ? 'button' : undefined}
                tabIndex={tile.type === 'brand' ? 0 : undefined}
                aria-pressed={tradeSelectionSide ? isTradeSelected : undefined}
                onClick={openTile}
                onKeyDown={(event) => {
                  if (tile.type === 'brand' && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault()
                    openTile()
                  }
                }}
              >
                {tile.price ? (
                  <div
                    className="price-strip"
                    style={{ '--price-color': tile.group ? groupColors[tile.group] : getTileTone(tile) } as CSSProperties}
                    title={
                      isMortgaged
                        ? 'Поле заложено'
                        : owner
                          ? isSubscriptionTile(tile)
                            ? `Подписка: сумма кубиков × ${subscriptionMultiplier}`
                            : isFleetTile(tile)
                              ? `Аренда автомобиля: ${money(fleetRent)}`
                              : `Аренда: ${money(currentRent)}`
                          : `Цена: ${money(tile.price)}`
                    }
                  >
                    {isMortgaged
                      ? 'ЗАЛОГ'
                      : owner && isSubscriptionTile(tile)
                        ? `×${subscriptionMultiplier}`
                        : owner && isFleetTile(tile)
                          ? money(fleetRent)
                          : money(owner ? currentRent : tile.price)}
                  </div>
                ) : null}

                {isLabeledEvent ? <div className="event-label-strip">{tile.label || tile.name}</div> : null}

                <div className="tile-content">
                  {tile.image ? (
                    <>
                      <img
                        className="tile-art"
                        src={tile.image}
                        alt=""
                        onError={(event) => { event.currentTarget.hidden = true }}
                        style={
                          {
                            '--art-rotation': `${tile.imageRotation ?? 0}deg`,
                            '--art-scale': tile.imageScale ?? 1,
                          } as CSSProperties
                        }
                      />
                      <span className="tile-image-fallback">{tile.label || tile.name}</span>
                    </>
                  ) : !isLabeledEvent ? (
                    <div className="tile-logo">{tile.label || tile.name}</div>
                  ) : null}
                  {tile.image && !isLabeledEvent && tile.imageMode !== 'cover' && tile.showCaption !== false ? (
                    <div className="tile-caption">{tile.label || tile.name}</div>
                  ) : null}
                </div>

                {ownerPlayer ? <div className="owner-ribbon" title={`Владелец: ${ownerPlayer.name}`} /> : null}
                {isMortgaged ? (
                  <div className="mortgage-countdown" title="Ходов до возврата поля банку">
                    <img src={eventImages.lock} alt="" />
                    {Math.max(0, (mortgageExpiryTurns[tile.id] ?? turnSequence) - turnSequence)}
                  </div>
                ) : null}
                {ownerPlayer && propertyLevel > 0 ? (
                  <div
                    className={`property-level ${propertyLevel >= maxPropertyLevel ? 'all-star' : ''}`}
                    title={`Уровень поля: ${propertyLevel}`}
                  >
                    {propertyLevel >= maxPropertyLevel ? (
                      <img src={eventImages.allStar} alt="Максимальный уровень" />
                    ) : (
                      Array.from({ length: propertyLevel }, (_, index) => (
                        <img src={eventImages.star} alt="" key={index} />
                      ))
                    )}
                  </div>
                ) : null}

                <div className="tokens">
                  {visibleTilePlayers.map((player) => (
                    <span
                      className={`token ${player.id === activePlayer.id ? 'active-token' : ''} ${hoveredOwnerId === player.id ? 'preview-token' : ''} ${jailedPlayerIds.includes(player.id) ? 'jailed' : ''} ${movingPlayerId === player.id ? 'moving' : ''}`}
                      key={player.id}
                      title={player.name}
                      style={{ '--player-color': player.color } as CSSProperties}
                    >
                      {player.avatar}
                    </span>
                  ))}
                </div>
                {tile.type === 'jail' ? (
                  <div className="tokens jail-tokens">
                    {jailedTilePlayers.map((player) => (
                      <span
                        className={`token jailed ${player.id === activePlayer.id ? 'active-token' : ''} ${hoveredOwnerId === player.id ? 'preview-token' : ''} ${movingPlayerId === player.id ? 'moving' : ''}`}
                        key={player.id}
                        title={player.name}
                        style={{ '--player-color': player.color } as CSSProperties}
                      >
                        {player.avatar}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}

          {diceAnimation ? <DiceRollAnimation key={diceAnimation.id} values={diceAnimation.values} /> : null}

          {movingPlayer ? (
            <span
              ref={movingTokenRef}
              className="token moving-token"
              title={movingPlayer.name}
              style={{ '--player-color': movingPlayer.color } as CSSProperties}
              aria-hidden="true"
            >
              {movingPlayer.avatar}
            </span>
          ) : null}

          <section className="center-panel">
          {pendingTile && canLocalPlayerAct ? (
            <div className="buy-dialog">
                <h2>Покупаем?</h2>
                <p>
                  {pendingPurchaseShortage > 0
                    ? `Не хватает ${money(pendingPurchaseShortage)}. Нажмите на своё поле, чтобы продать звезду или оформить залог.`
                    : 'Если отказаться, поле позже можно будет выставить на общий аукцион.'}
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="purchase-button"
                    onClick={buyPendingTile}
                    disabled={!canLocalPlayerAct || pendingPurchaseShortage > 0}
                  >
                    Купить за {money(pendingTile.price ?? 0)}
                  </button>
                  <button type="button" className="auction-button" onClick={skipPurchase} disabled={!canLocalPlayerAct}>
                    На аукцион
                  </button>
              </div>
            </div>
          ) : null}

          {pendingPayment && paymentPayer && paymentTile && canLocalPlayerPay ? (
            <section className="game-dialog payment-dialog" aria-label="Обязательный платёж">
              <small>Обязательный платёж</small>
              <h2>
                {pendingPayment.kind === 'rent'
                  ? isSubscriptionTile(paymentTile)
                    ? 'Оплатите подписку'
                    : 'Заплатите аренду'
                  : pendingPayment.kind === 'tax'
                    ? 'Заплатите налог'
                    : 'Оплатите событие'}
              </h2>
              <p>
                {pendingPayment.kind === 'rent' && paymentRecipient ? (
                  <>
                    <b style={{ color: paymentPayer.color }}>{paymentPayer.name}</b> должен заплатить{' '}
                    <b style={{ color: paymentRecipient.color }}>{paymentRecipient.name}</b>{' '}
                    {isSubscriptionTile(paymentTile) ? 'за подписку ' : 'за поле '}
                    <strong>{paymentTile.name}</strong>.
                  </>
                ) : pendingPayment.kind === 'tax' ? (
                  <>
                    <b style={{ color: paymentPayer.color }}>{paymentPayer.name}</b> должен заплатить налог банку.
                  </>
                ) : (
                  <>
                    <b style={{ color: paymentPayer.color }}>{paymentPayer.name}</b> должен выполнить платёж
                    {' '}по событию <strong>{pendingPayment.eventLabel ?? 'Вопросик'}</strong>.
                  </>
                )}
              </p>
              {paymentPayer.money < pendingPayment.amount ? (
                <p className={getPlayerMaximumCash(paymentPayer.id) < pendingPayment.amount ? 'payment-bankrupt' : 'payment-shortage'}>
                  {getPlayerMaximumCash(paymentPayer.id) < pendingPayment.amount
                    ? 'Даже после продажи всех звёзд и залога полей денег не хватит. Игрок может только сдаться.'
                    : `Не хватает ${money(pendingPayment.amount - paymentPayer.money)}. Продайте звёзды или заложите свои поля.`}
                </p>
              ) : null}
              <div
                className={`payment-actions ${getPlayerMaximumCash(paymentPayer.id) < pendingPayment.amount ? '' : 'payment-actions-single'}`}
              >
                <button
                  type="button"
                  className="purchase-button"
                  onClick={payPendingRent}
                  disabled={!canLocalPlayerPay || paymentPayer.money < pendingPayment.amount}
                >
                  Оплатить {money(pendingPayment.amount)}
                </button>
                {getPlayerMaximumCash(paymentPayer.id) < pendingPayment.amount ? (
                  <button
                    type="button"
                    className="surrender-button"
                    onClick={() => surrenderPlayer(paymentPayer.id)}
                    disabled={!canLocalPlayerPay}
                  >
                    Сдаться
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {casino && casinoPlayer && (!localPlayerId || localPlayerId === casinoPlayer.id) ? (
            <section className="game-dialog casino-dialog" aria-label="Казино">
              <small>Казино</small>
              <h2>{casino.rolledNumber === undefined ? 'Вы в казино!' : 'Результат игры'}</h2>
              {casino.rolledNumber === undefined ? (
                <>
                  <p>
                    Выберите от <b>1 до 3 чисел</b> и бросьте кубик. Чем меньше чисел выбрано, тем больше выигрыш.
                  </p>
                  <p className="casino-bonus">
                    <b>Суперприз: {money(casinoJackpot)}</b> можно выиграть независимо от угаданного числа.
                  </p>
                </>
              ) : (
                <p className={casino.payout ? 'casino-result won' : 'casino-result'}>
                  {casino.jackpotWon
                    ? `Суперприз! Общий выигрыш: ${money(casino.payout ?? 0)}`
                    : casino.selectedNumbers.includes(casino.rolledNumber)
                      ? `Число угадано! Выигрыш: ${money(casino.payout ?? 0)}`
                      : `Выпало ${casino.rolledNumber}. Ставка ${money(casinoBet)} проиграна.`}
                </p>
              )}
              <div className="casino-number-row">
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <button
                    type="button"
                    className={`casino-number ${casino.selectedNumbers.includes(value) ? 'selected' : ''}`}
                    key={value}
                    onClick={() => toggleCasinoNumber(value)}
                    disabled={!canLocalPlayerAct || casino.rolledNumber !== undefined}
                    aria-pressed={casino.selectedNumbers.includes(value)}
                    aria-label={`Выбрать число ${value}`}
                  >
                    <CasinoDie value={value} selected={casino.selectedNumbers.includes(value)} />
                  </button>
                ))}
                <span className="casino-result-divider">→</span>
                <span className="casino-rolled-die">
                  {casino.rolledNumber === undefined ? '—' : <CasinoDie value={casino.rolledNumber} />}
                </span>
              </div>
              {casino.rolledNumber === undefined ? (
                <div className="casino-actions">
                  <button
                    type="button"
                    className="purchase-button"
                    onClick={playCasino}
                    disabled={!canLocalPlayerAct || casino.selectedNumbers.length === 0 || casinoPlayer.money < casinoBet || isRolling}
                  >
                    {casinoPlayer.money < casinoBet
                      ? `Не хватает ${money(casinoBet - casinoPlayer.money)}`
                      : isRolling
                        ? 'Кубик брошен...'
                        : `Поставить ${money(casinoBet)}`}
                  </button>
                  <button type="button" className="quiet-button" onClick={declineCasino} disabled={!canLocalPlayerAct || isRolling}>
                    Отказаться
                  </button>
                </div>
              ) : (
                <button type="button" className="purchase-button casino-continue" onClick={finishCasino} disabled={!canLocalPlayerAct}>
                  Продолжить
                </button>
              )}
            </section>
          ) : null}

          {auction && auctionTile && auctionBidder ? (
            <section className="game-dialog auction-dialog" aria-label="Аукцион">
              {canLocalPlayerBidAtAuction ? (
                <button type="button" className="dialog-close" onClick={() => passAuction()} aria-label="Выйти из торгов">
                  ×
                </button>
              ) : null}
              <div className="dialog-heading">
                {auctionTile.image ? (
                  <img
                    src={auctionTile.image}
                    alt=""
                    style={{ transform: `rotate(${auctionTile.imageRotation ?? 0}deg)` }}
                  />
                ) : null}
                <div>
                  <small>Общий аукцион</small>
                  <h2>{auctionTile.name}</h2>
                </div>
              </div>
              <div className="auction-status">
                <span>{isSoleAuctionDecision ? 'Цена покупки без торгов' : auction.highestBidderId ? 'Текущая ставка' : 'Стартовая цена поля'}</span>
                <strong className="auction-bid-preview">
                  <span>{money(auction.currentBid)}</span>
                  {(isSoleAuctionDecision || Number(auctionBid) > 0) ? (
                    <>
                      <i aria-hidden="true">→</i>
                      <b>{money(auction.currentBid + (isSoleAuctionDecision ? auctionIncrement : Math.floor(Number(auctionBid))))}</b>
                    </>
                  ) : null}
                </strong>
                <small>
                  {isSoleAuctionDecision
                    ? `Фиксированная добавка: ${money(auctionIncrement)}`
                    : `Минимальное повышение: ${money(auctionIncrement)}`}
                </small>
                <span>
                  Ход: <b style={{ color: auctionBidder.color }}>{auctionBidder.name}</b>
                </span>
              </div>
              {canLocalPlayerBidAtAuction ? (
                <div className={isSoleAuctionDecision ? 'auction-controls sole-bidder' : 'auction-controls'}>
                {!isSoleAuctionDecision ? (
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={auctionBid}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, '')
                      const maximumIncrease = Math.max(0, auctionBidder.money - auction.currentBid)
                      setAuctionBid(digits ? String(Math.min(Number(digits), maximumIncrease)) : '')
                    }}
                    onBlur={() => {
                      if (Number(auctionBid) < auctionIncrement) setAuctionBid(String(auctionIncrement))
                    }}
                    aria-label="Повышение ставки"
                  />
                ) : null}
                <button
                  type="button"
                  className="auction-button"
                  onClick={placeAuctionBid}
                  disabled={
                    (isSoleAuctionDecision ? auctionIncrement : Number(auctionBid)) < auctionIncrement ||
                    auction.currentBid + (isSoleAuctionDecision ? auctionIncrement : Number(auctionBid)) > auctionBidder.money
                  }
                >
                  {isSoleAuctionDecision ? 'Купить' : 'Ставка'}{' '}
                  {money(auction.currentBid + (isSoleAuctionDecision
                    ? auctionIncrement
                    : Math.max(0, Math.floor(Number(auctionBid) || 0))))}
                </button>
                <button type="button" className="quiet-button" onClick={passAuction}>
                  Пас
                </button>
                </div>
              ) : (
                <p className="decision-waiting-message">Ожидаем решение игрока {auctionBidder.name}…</p>
              )}
              <div className="auction-players">
                {auction.participantIds.map((id) => {
                  const bidder = players.find((player) => player.id === id)
                  if (!bidder) return null
                  const isHighest = auction.highestBidderId === id
                  const hasPassed = auction.passedIds.includes(id)
                  return (
                    <span
                      className={`${isHighest ? 'highest' : ''} ${hasPassed ? 'passed' : ''}`}
                      key={id}
                      style={{ '--bidder-color': bidder.color } as CSSProperties}
                    >
                      {bidder.name} {isHighest ? '· делает ставку' : hasPassed ? '· пас' : ''}
                    </span>
                  )
                })}
              </div>
            </section>
          ) : null}

          {tradeDraft && tradeTarget && canLocalPlayerSeeTrade ? (
            <section className="game-dialog trade-dialog" aria-label="Обмен">
              <button
                type="button"
                className="dialog-close"
                onClick={closeSharedTrade}
                disabled={tradeDraft.stage === 'review' ? !canLocalPlayerAnswerTrade : !canLocalPlayerAct}
                aria-label="Закрыть"
              >
                ×
              </button>
              <header>
                <small>{tradeDraft.stage === 'review' ? 'Подтверждение предложения' : 'Договор'}</small>
                <h2>Обмен с {tradeTarget.name}</h2>
              </header>
              <p className="trade-hint">
                {tradeDraft.stage === 'draft'
                  ? 'Нажимайте на свои поля и поля второго игрока прямо на доске.'
                  : 'Проверьте состав сделки перед подтверждением.'}
              </p>
              <div className="trade-columns">
                {([
                  {
                    player: activePlayer,
                    moneyKey: 'offeredMoney' as const,
                    tileKey: 'offeredTileIds' as const,
                    side: 'offered' as const,
                    title: 'Вы отдаете',
                  },
                  {
                    player: tradeTarget,
                    moneyKey: 'requestedMoney' as const,
                    tileKey: 'requestedTileIds' as const,
                    side: 'requested' as const,
                    title: `${tradeTarget.name} отдает`,
                  },
                ]).map((column) => {
                  const selectedTiles = column.tileKey === 'offeredTileIds'
                    ? tradeDraft.offeredTileIds
                    : tradeDraft.requestedTileIds
                  const selectedPropertyValue = selectedTiles.reduce((total, tileId) => {
                    const tile = brandTiles.find((item) => item.id === tileId)
                    if (!tile) return total
                    return total + (tile.price ?? 0) + (propertyLevels[tile.id] ?? 0) * getUpgradeCost(tile)
                  }, 0)
                  const tradeSideTotal = tradeDraft[column.moneyKey] + selectedPropertyValue

                  return (
                    <div className="trade-column" key={column.player.id}>
                      <div className="trade-player-heading" style={{ '--player-color': column.player.color } as CSSProperties}>
                        <span>{column.player.avatar}</span>
                        <div>
                          <small>{column.title}</small>
                          <h3>{column.player.name}</h3>
                          <b className="trade-player-balance">
                            Баланс: {money(column.player.money)}
                            {tradeDraft[column.moneyKey] > 0 ? (
                              <>
                                <span aria-hidden="true">→</span>
                                <strong>{money(column.player.money - tradeDraft[column.moneyKey])}</strong>
                              </>
                            ) : null}
                          </b>
                        </div>
                      </div>
                      <label className="trade-money-field">
                        <span>Деньги</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={tradeDraft[column.moneyKey] || ''}
                          disabled={!canLocalPlayerAct || tradeDraft.stage === 'review'}
                          onChange={(event) =>
                            setTradeDraft({
                              ...tradeDraft,
                              [column.moneyKey]: Math.max(
                                0,
                                Math.min(
                                  Math.max(0, column.player.money),
                                  Math.floor(Number(event.target.value.replace(/\D/g, '')) || 0),
                                ),
                              ),
                            })
                          }
                        />
                      </label>
                      <div className="trade-properties" aria-label={`Поля: ${column.title}`}>
                        {selectedTiles.length ? (
                          selectedTiles.map((tileId) => {
                            const tile = brandTiles.find((item) => item.id === tileId)
                            if (!tile) return null

                            return (
                              <button
                                type="button"
                                className="trade-property"
                                key={tile.id}
                                disabled={!canLocalPlayerAct || tradeDraft.stage === 'review'}
                                onClick={() => toggleTradeTile(column.side, tile.id)}
                                title={tradeDraft.stage === 'draft' ? 'Убрать из предложения' : undefined}
                              >
                                {tile.image ? (
                                  <img
                                    src={tile.image}
                                    alt=""
                                    style={{ transform: `rotate(${tile.imageRotation ?? 0}deg)` }}
                                  />
                                ) : null}
                                <span>{tile.name}</span>
                                <b>
                                  {mortgagedPropertyIds.includes(tile.id)
                                    ? (
                                      <span className="trade-mortgage-status">
                                        <img src={eventImages.lock} alt="Залог" />
                                        {Math.max(0, (mortgageExpiryTurns[tile.id] ?? turnSequence) - turnSequence)}
                                      </span>
                                    )
                                    : money((tile.price ?? 0) + (propertyLevels[tile.id] ?? 0) * getUpgradeCost(tile))}
                                </b>
                              </button>
                            )
                          })
                        ) : (
                          <p>Выберите поле на доске</p>
                        )}
                      </div>
                      <div className="trade-total-breakdown" aria-label="Расчёт стоимости предложения">
                        <span>Поля <b>{money(selectedPropertyValue)}</b></span>
                        <span>Деньги <b>{money(tradeDraft[column.moneyKey])}</b></span>
                      </div>
                      <div className="trade-total">
                        <span>Итого отдаёт</span>
                        <b>{money(tradeSideTotal)}</b>
                      </div>
                    </div>
                  )
                })}
              </div>
              <footer className="trade-footer">
                {tradeDraft.stage === 'draft' ? (
                  <button
                    type="button"
                    className="purchase-button"
                    onClick={submitTrade}
                    disabled={!canLocalPlayerAct || tradeRequestsThisTurn >= maxTradeRequestsPerTurn}
                  >
                    Предложить обмен ({tradeRequestsThisTurn + 1}/{maxTradeRequestsPerTurn})
                  </button>
                ) : (
                  <>
                    <button type="button" className="purchase-button" onClick={acceptTrade} disabled={!canLocalPlayerAnswerTrade}>
                      Принять
                    </button>
                    <button type="button" className="quiet-button" onClick={closeSharedTrade} disabled={!canLocalPlayerAnswerTrade}>
                      Отклонить
                    </button>
                  </>
                )}
              </footer>
            </section>
          ) : null}

          {selectedProperty ? (
            <section
              ref={propertyDialogRef}
              className={`game-dialog property-dialog property-side-${getTileSide(selectedProperty.id)}`}
              aria-label={`Карточка поля ${selectedProperty.name}`}
              style={{
                '--property-color': getTileTone(selectedProperty),
                '--property-axis': `${getPropertyDialogAxis(selectedProperty.id)}%`,
              } as CSSProperties}
            >
              <button type="button" className="dialog-close" onClick={() => setSelectedPropertyId(null)} aria-label="Закрыть">
                ×
              </button>
              <header className="property-heading">
                {selectedProperty.image ? (
                  <img
                    src={selectedProperty.image}
                    alt=""
                    style={{ transform: `rotate(${selectedProperty.imageRotation ?? 0}deg)` }}
                  />
                ) : null}
                <div>
                  <small>{groupLabels[selectedProperty.group ?? ''] ?? selectedProperty.group}</small>
                  <h2>{selectedProperty.name}</h2>
                  <span>
                    {mortgagedPropertyIds.includes(selectedProperty.id)
                      ? `Поле заложено — осталось ${Math.max(0, (mortgageExpiryTurns[selectedProperty.id] ?? turnSequence) - turnSequence)} ходов`
                      : owners[selectedProperty.id]
                      ? `Владелец: ${players.find((player) => player.id === owners[selectedProperty.id])?.name ?? 'Игрок'}`
                      : 'Поле свободно'}
                  </span>
                </div>
              </header>
              {isSubscriptionTile(selectedProperty) ? (
                <div className="subscription-rent-info">
                  <p>Стоимость подписки зависит от суммы на кубиках и количества подписок у владельца.</p>
                  <div>
                    <span>1 подписка</span>
                    <b>🎲 × {subscriptionRentMultipliers[0]}</b>
                  </div>
                  <div>
                    <span>2 подписки</span>
                    <b>🎲 × {subscriptionRentMultipliers[1]}</b>
                  </div>
                </div>
              ) : isFleetTile(selectedProperty) ? (
                <div className="subscription-rent-info">
                  <p>Аренда зависит от количества автомобилей у владельца.</p>
                  {fleetRentLevels.map((rent, index) => (
                    <div key={rent}>
                      <span>{index + 1} {index === 0 ? 'автомобиль' : index === 3 ? 'автомобиля' : 'автомобиля'}</span>
                      <b>{money(rent)}</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rent-table">
                  {rentMultipliers.map((_, level) => (
                    <div className={level === (propertyLevels[selectedProperty.id] ?? 0) ? 'current' : ''} key={level}>
                      <span>{level === 0 ? 'Базовая аренда' : '★'.repeat(level)}</span>
                      <b>{money(getRentAtLevel(selectedProperty, level))}</b>
                    </div>
                  ))}
                </div>
              )}
              <div className="property-facts">
                <span>Стоимость поля <b>{money(selectedProperty.price ?? 0)}</b></span>
                <span>Залог поля <b>{money(getMortgageValue(selectedProperty))}</b></span>
                <span>Выкуп поля <b>{money(getRedemptionCost(selectedProperty))}</b></span>
                {isUpgradeableTile(selectedProperty) ? (
                  <>
                    <span>Улучшение <b>{money(getUpgradeCost(selectedProperty))}</b></span>
                    <span>Продажа звезды <b>{money(getStarSaleValue(selectedProperty))}</b></span>
                  </>
                ) : null}
              </div>
              {canLocalPlayerUsePropertyActions && (
                owners[selectedProperty.id] === activePlayer.id ||
                (!owners[selectedProperty.id] && pendingTile?.id === selectedProperty.id)
              ) ? (
                <div
                  className={`property-actions ${
                    !owners[selectedProperty.id] || !isUpgradeableTile(selectedProperty)
                      ? 'property-actions-single'
                      : ''
                  }`}
                >
                  {!owners[selectedProperty.id] || isUpgradeableTile(selectedProperty) ? (
                  <button
                    type="button"
                    className="upgrade-button"
                    onClick={owners[selectedProperty.id] ? upgradeSelectedProperty : buyPendingTile}
                    disabled={
                      owners[selectedProperty.id]
                        ? Boolean(pendingPayment) ||
                          !selectedProperty.group ||
                          completedGroups[selectedProperty.group]?.id !== activePlayer.id ||
                          mortgagedPropertyIds.includes(selectedProperty.id) ||
                          brandTiles.some(
                            (tile) =>
                              tile.group === selectedProperty.group && mortgagedPropertyIds.includes(tile.id),
                          ) ||
                          !canUpgradePropertyEvenly(selectedProperty, propertyLevels) ||
                          upgradedGroupsThisTurn.includes(selectedProperty.group) ||
                          (propertyLevels[selectedProperty.id] ?? 0) >= maxPropertyLevel ||
                          activePlayer.money < selectedUpgradeCost
                        : activePlayer.money < (selectedProperty.price ?? 0)
                    }
                  >
                    {!owners[selectedProperty.id]
                      ? activePlayer.money < (selectedProperty.price ?? 0)
                        ? `Не хватает ${money((selectedProperty.price ?? 0) - activePlayer.money)}`
                        : `Купить за ${money(selectedProperty.price ?? 0)}`
                      : pendingPayment
                        ? 'Сначала оплатите аренду'
                        : mortgagedPropertyIds.includes(selectedProperty.id)
                          ? 'Поле заложено'
                          : (propertyLevels[selectedProperty.id] ?? 0) >= maxPropertyLevel
                            ? 'Максимальный уровень'
                            : completedGroups[selectedProperty.group ?? '']?.id !== activePlayer.id
                              ? 'Нужна вся монополия'
                              : !canUpgradePropertyEvenly(selectedProperty, propertyLevels)
                                ? 'Сначала улучшите остальные поля'
                                : upgradedGroupsThisTurn.includes(selectedProperty.group ?? '')
                                  ? 'В этой монополии уже было улучшение'
                                  : `Улучшить за ${money(selectedUpgradeCost)}`}
                  </button>
                  ) : null}
                  {owners[selectedProperty.id] === activePlayer.id ? (
                    <button
                      type="button"
                      className={(propertyLevels[selectedProperty.id] ?? 0) > 0 ? 'sell-star-button' : 'mortgage-button'}
                      onClick={
                        (propertyLevels[selectedProperty.id] ?? 0) > 0
                          ? sellSelectedPropertyStar
                          : toggleSelectedPropertyMortgage
                      }
                      disabled={
                        ((propertyLevels[selectedProperty.id] ?? 0) > 0 &&
                          !canSellPropertyStarEvenly(selectedProperty, propertyLevels)) ||
                        ((propertyLevels[selectedProperty.id] ?? 0) === 0 &&
                          !mortgagedPropertyIds.includes(selectedProperty.id) &&
                          !canMortgageProperty(selectedProperty, propertyLevels)) ||
                        (mortgagedPropertyIds.includes(selectedProperty.id) &&
                          activePlayer.money < getRedemptionCost(selectedProperty))
                      }
                    >
                      {(propertyLevels[selectedProperty.id] ?? 0) > 0
                        ? !canSellPropertyStarEvenly(selectedProperty, propertyLevels)
                          ? 'Сначала продайте звёзды с других полей'
                          : `Продать ★ за ${money(getStarSaleValue(selectedProperty))}`
                        : mortgagedPropertyIds.includes(selectedProperty.id)
                          ? `Выкупить за ${money(getRedemptionCost(selectedProperty))}`
                          : !canMortgageProperty(selectedProperty, propertyLevels)
                            ? 'Сначала продайте звёзды всей монополии'
                            : `Заложить за ${money(getMortgageValue(selectedProperty))}`}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {canLocalPlayerUseTurnControls ? (
            <div
              className={`turn-card ${isActivePlayerJailed ? 'jailed-turn-card' : ''} ${
              (pendingTile && canLocalPlayerAct) ||
              (pendingPayment && canLocalPlayerPay) ||
              (casino && (!localPlayerId || localPlayerId === casino.playerId))
                ? 'dialog-covered'
                : ''
            }`}
            style={{ '--player-color': activePlayer.color } as CSSProperties}
          >
            <small>{isActivePlayerJailed ? 'Тюрьма — ход игрока' : 'Ход игрока'}</small>
            <strong>{activePlayer.name}</strong>
            <div className="dice-zone">
              <div className="dice">
                <span>{lastRoll?.dice[0] ?? '-'}</span>
                <span>{lastRoll?.dice[1] ?? '-'}</span>
              </div>
              {isActivePlayerJailed ? (
                <p className="jail-message">
                  {isForcedJailRelease
                    ? getPlayerMaximumCash(activePlayer.id) < jailReleaseCost && !playerEffects[activePlayer.id]?.freeJailRelease
                      ? 'Три попытки закончились. Денег и активов для выхода не хватает — игрок проигрывает.'
                      : 'Три попытки закончились. На этом ходу нужно обязательно выйти из тюрьмы.'
                    : `Вы в тюрьме: неудачных попыток ${activeJailFailedAttempts}/3. Заплатите или попробуйте выбросить дубль.`}
                </p>
              ) : null}
              <div className={`turn-actions ${isActivePlayerJailed ? 'jail-release-actions' : ''}`}>
                {isActivePlayerJailed ? (
                  <button
                    type="button"
                    className="purchase-button"
                    onClick={payJailRelease}
                    disabled={!canLocalPlayerAct || (!playerEffects[activePlayer.id]?.freeJailRelease && activePlayer.money < jailReleaseCost) || isRolling}
                  >
                    {playerEffects[activePlayer.id]?.freeJailRelease
                      ? 'Вызвать адвоката бесплатно'
                      : `Выйти за ${money(jailReleaseCost)}`}
                  </button>
                ) : null}
                {isForcedJailRelease &&
                getPlayerMaximumCash(activePlayer.id) < jailReleaseCost &&
                !playerEffects[activePlayer.id]?.freeJailRelease ? (
                  <button
                    type="button"
                    className="surrender-button"
                    onClick={() => surrenderPlayer(activePlayer.id)}
                    disabled={!canLocalPlayerAct || players.length <= 1}
                  >
                    Сдаться
                  </button>
                ) : !isForcedJailRelease ? (
                  <button
                    type="button"
                    className="roll-button"
                    onClick={rollDice}
                    disabled={
                      isRolling ||
                      !canLocalPlayerAct ||
                      Boolean(turnDeadline && secondsLeft <= 1) ||
                      Boolean(pendingTile) ||
                      Boolean(pendingPayment) ||
                      Boolean(casino) ||
                      Boolean(auction) ||
                      Boolean(tradeDraft)
                    }
                  >
                    {isRolling ? 'Собираю...' : isActivePlayerJailed ? 'Попытаться выбросить дубль' : 'Бросить'}
                  </button>
                ) : null}
              </div>
            </div>
            </div>
          ) : (
            <div
              className="turn-card spectator-turn-card"
              style={{ '--player-color': decisionPlayer.color } as CSSProperties}
              aria-live="polite"
            >
              <small>Сейчас ходит</small>
              <strong>{decisionPlayer.name}</strong>
            </div>
          )}

            <div className={`log-panel ${minimalistChat ? 'minimalist-chat' : ''}`}>
              <div
                className="log-list"
                ref={logListRef}
                onScroll={(event) => {
                  const element = event.currentTarget
                  const isPinned = element.scrollHeight - element.scrollTop - element.clientHeight < 40
                  keepLogPinnedRef.current = isPinned
                  if (isPinned) setUnreadLogCount(0)
                }}
              >
              {logs.map((entry) => {
                const player = players.find((item) => item.id === entry.playerId)
                const showTradeHistoryPreview = () => {
                  if (!entry.tradeDetails) return
                  setTradeHistoryPreview(Object.fromEntries(
                    entry.tradeDetails.sides.flatMap((side) =>
                      side.assets.map((asset) => [asset.tileId, side.color]),
                    ),
                  ))
                }
                const hideTradeHistoryPreview = () => setTradeHistoryPreview({})

                return (
                  <article
                    className={`event-card ${entry.tradeDetails ? 'trade-event-card' : ''}`}
                    key={entry.id}
                    style={{ '--entry-color': player?.color ?? '#73808c' } as CSSProperties}
                    tabIndex={entry.tradeDetails ? 0 : undefined}
                    onMouseEnter={showTradeHistoryPreview}
                    onMouseLeave={hideTradeHistoryPreview}
                    onFocus={showTradeHistoryPreview}
                    onBlur={hideTradeHistoryPreview}
                  >
                    <span className={`event-icon ${entry.kind ?? 'system'}`} aria-hidden="true">
                      {entry.kind === 'roll' ? (
                        <img className="event-image" src={eventImages.dice} alt="" />
                      ) : entry.kind === 'buy' ? (
                        <img className="event-image" src={eventImages.buy} alt="" />
                      ) : entry.kind === 'rent' ? (
                        <img className="event-image" src={eventImages.money} alt="" />
                      ) : entry.kind === 'thinking-buy' ? (
                        <img className="event-image" src={eventImages.thinkingBuy} alt="" />
                      ) : entry.kind === 'tax' ? (
                        <img className="event-image" src={eventImages.tax} alt="" />
                      ) : entry.kind === 'jackpot' ? (
                        <img className="event-image casino-event-image" src={eventImages.jackpotChat} alt="" />
                      ) : entry.kind === 'trade' ? (
                        <img className="event-image" src={eventImages.trade} alt="" />
                      ) : entry.kind === 'auction' ? (
                        <img className="event-image" src={eventImages.gavel} alt="" />
                      ) : entry.kind === 'jail' ? (
                        <img className="event-image" src={eventImages.jail} alt="" />
                      ) : entry.kind === 'diamond' ? (
                        <img className="event-image" src={eventImages.diamond} alt="" />
                      ) : entry.kind === 'chance' ? (
                        <img className="event-image" src={eventImages.question} alt="" />
                      ) : entry.kind === 'chat' ? (
                        <img className="event-image" src={eventImages.chat} alt="" />
                      ) : player ? (
                        <span className="event-avatar">{player.avatar}</span>
                      ) : (
                        <span className="event-system" />
                      )}
                    </span>
                    <p>{renderEventText(entry)}</p>
                    <time>{entry.time}</time>
                    {entry.amount ? (
                      <span className={`event-amount ${entry.amount > 0 ? 'positive' : 'negative'}`}>
                        {deltaMoney(entry.amount)}
                      </span>
                    ) : null}
                    {entry.tradeDetails ? (
                      <div className="trade-event-details" aria-label="Состав обмена">
                        {entry.tradeDetails.sides.map((side) => (
                          <section
                            className="trade-event-side"
                            key={side.playerId}
                            style={{ '--trade-player-color': side.color } as CSSProperties}
                          >
                            <strong>{side.playerName} получает</strong>
                            {side.assets.length > 0 ? (
                              <ul>
                                {side.assets.map((asset) => (
                                  <li key={asset.tileId}>
                                    <span>{asset.name}</span>
                                    {asset.level > 0 ? <small>★ × {asset.level}</small> : null}
                                    {asset.mortgageTurns !== undefined ? (
                                      <small className="trade-event-mortgage">Залог: {asset.mortgageTurns} ходов</small>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {side.money > 0 ? <b className="trade-event-money">+ {money(side.money)}</b> : null}
                            {side.assets.length === 0 && side.money === 0 ? <span>Ничего</span> : null}
                          </section>
                        ))}
                      </div>
                    ) : null}
                  </article>
                )
              })}
              </div>
              {unreadLogCount > 0 ? (
                <button type="button" className="new-log-indicator" onClick={scrollToLatestLogs}>
                  Новых событий: {unreadLogCount} ↓
                </button>
              ) : null}
            </div>

            {lastRoll ? (
              <details className="entropy-panel">
                <summary>Источники рандома: seed {lastRoll.seed}</summary>
                <p>{lastRoll.formula}</p>
                <ul>
                  {lastRoll.samples.map((sample) => (
                    <li key={sample.source}>
                      {sample.label}: {Math.round(sample.value)} ({sample.status})
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="chat-input">
              <input
                type="text"
                value={message}
                maxLength={256}
                placeholder="Введите сообщение..."
                onChange={(event) => setMessage(event.target.value.slice(0, 256))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') sendMessage()
                }}
              />
              <button type="button" onClick={sendMessage} aria-label="Отправить сообщение">
                ›
              </button>
            </div>
          </section>
        </div>

        <div className="group-legend">
          {Object.entries(groupColors).map(([group, color]) => {
            const monopolyOwner = completedGroups[group]

            return (
            <span
              className={monopolyOwner ? 'completed' : ''}
              key={group}
              title={monopolyOwner ? `Монополия «${groupLabels[group]}» собрана игроком ${monopolyOwner.name}` : groupLabels[group]}
              tabIndex={0}
              onMouseEnter={() => setHoveredGroup(group)}
              onMouseLeave={() => setHoveredGroup(null)}
              onFocus={() => setHoveredGroup(group)}
              onBlur={() => setHoveredGroup(null)}
              style={
                {
                  '--group-color': color,
                  '--monopoly-owner-color': monopolyOwner?.color ?? 'transparent',
                } as CSSProperties
              }
            >
              <i style={{ background: color }} />
              {groupLabels[group] ?? group}
            </span>
            )
          })}
        </div>
      </section>
    </GameViewport>
  )
}

export default App
