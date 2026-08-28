export type Player = {
  id: string
  name: string
  color: string
  avatar: string
  money: number
  position: number
  lastDelta?: number
}

export type TileType =
  | 'start'
  | 'brand'
  | 'chance'
  | 'diamond'
  | 'tax'
  | 'jail'
  | 'casino'
  | 'police'
  | 'empty'

export type Tile = {
  id: number
  name: string
  type: TileType
  price?: number
  rent?: number
  rentLevels?: number[]
  rentMode?: 'dice-multiplier' | 'fleet-multiplier'
  group?: string
  label?: string
  image?: string
  imageMode?: 'contain' | 'cover'
  showCaption?: boolean
  imageRotation?: number
  imageScale?: number
}

export type EntropySample = {
  source: string
  label: string
  value: number
  status: 'live' | 'fallback'
}

export type DiceRoll = {
  dice: [number, number]
  total: number
  seed: number
  formula: string
  samples: EntropySample[]
}

export type TradeLogAsset = {
  tileId: number
  name: string
  level: number
  mortgageTurns?: number
}

export type TradeLogSide = {
  playerId: string
  playerName: string
  color: string
  money: number
  assets: TradeLogAsset[]
}

export type TradeLogDetails = {
  sides: [TradeLogSide, TradeLogSide]
}

export type LogEntry = {
  id: string
  playerId?: string
  text: string
  kind?:
    | 'system'
    | 'roll'
    | 'move'
    | 'thinking-buy'
    | 'buy'
    | 'rent'
    | 'tax'
    | 'jackpot'
    | 'chat'
    | 'trade'
    | 'auction'
    | 'upgrade'
    | 'mortgage'
    | 'jail'
    | 'diamond'
    | 'chance'
    | 'bankruptcy'
  amount?: number
  time?: string
  tradeDetails?: TradeLogDetails
}
