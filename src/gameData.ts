import type { Player, Tile } from './types'

const rocketMap = new URL('../pic/rocket_map.png', import.meta.url).href
const jackpotMap = new URL('../pic/jackpot_map.png', import.meta.url).href
const policeMap = new URL('../pic/police_map.png', import.meta.url).href
const policeMan = new URL('../pic/police_man.png', import.meta.url).href
const diceChat = new URL('../pic/dice_chat.png', import.meta.url).href
const buyIcon = new URL('../pic/buy.png', import.meta.url).href
const moneyIcon = new URL('../pic/money.png', import.meta.url).href
const chatIcon = new URL('../pic/chat.png', import.meta.url).href
const thinkingBuyIcon = new URL('../pic/thinking_buy.png', import.meta.url).href
const tradeIcon = new URL('../pic/trade.png', import.meta.url).href
const gavelIcon = new URL('../pic/Gavel.png', import.meta.url).href
const starIcon = new URL('../pic/Star.png', import.meta.url).href
const allStarIcon = new URL('../pic/AllStar.png', import.meta.url).href
const lockIcon = new URL('../pic/lock.png', import.meta.url).href
const jailIcon = new URL('../pic/jail.png', import.meta.url).href
const jackpotChatIcon = new URL('../pic/Jacpot_chat.png', import.meta.url).href

const logoFiles = {
  adidas: new URL('../logo/Adidas.png', import.meta.url).href,
  amazon: new URL('../logo/Amazon.png', import.meta.url).href,
  appleTv: new URL('../logo/AppleTV.png', import.meta.url).href,
  balenciaga: new URL('../logo/Balenciaga.png', import.meta.url).href,
  bentley: new URL('../logo/Bently.png', import.meta.url).href,
  claude: new URL('../logo/Claude.png', import.meta.url).href,
  diamond: new URL('../logo/Dimond.png', import.meta.url).href,
  electronicArts: new URL('../logo/EA.png', import.meta.url).href,
  epicGames: new URL('../logo/EpicGames.png', import.meta.url).href,
  fansly: new URL('../logo/Fansly.png', import.meta.url).href,
  fanvue: new URL('../logo/fanvue.png', import.meta.url).href,
  google: new URL('../logo/Google.png', import.meta.url).href,
  chatGpt: new URL('../logo/GPT.png', import.meta.url).href,
  grok: new URL('../logo/GROK.png', import.meta.url).href,
  instagram: new URL('../logo/Inst.png', import.meta.url).href,
  kari: new URL('../logo/Kari.png', import.meta.url).href,
  louisVuitton: new URL('../logo/Louis Vuitton.png', import.meta.url).href,
  microsoft: new URL('../logo/Microsoft.png', import.meta.url).href,
  nasa: new URL('../logo/Nasa.png', import.meta.url).href,
  netflix: new URL('../logo/Netflix.png', import.meta.url).href,
  nike: new URL('../logo/Nike.png', import.meta.url).href,
  onlyFans: new URL('../logo/OnlyFans.png', import.meta.url).href,
  porsche: new URL('../logo/Porshe.png', import.meta.url).href,
  reddit: new URL('../logo/reddit.png', import.meta.url).href,
  rollsRoyce: new URL('../logo/RollsRoyce.png', import.meta.url).href,
  question: new URL('../logo/QustionMark.png', import.meta.url).href,
  spaceX: new URL('../logo/spaceX.png', import.meta.url).href,
  steam: new URL('../logo/Steam.png', import.meta.url).href,
  tax: new URL('../logo/Tax.png', import.meta.url).href,
  tesla: new URL('../logo/Tesla.png', import.meta.url).href,
  tikTok: new URL('../logo/TikTok.png', import.meta.url).href,
} as const

const logo = (file: (typeof logoFiles)[keyof typeof logoFiles]) => file

const brandArt = (
  file: (typeof logoFiles)[keyof typeof logoFiles],
  imageRotation = 0,
  imageScale = 1.6,
): Pick<Tile, 'image' | 'imageMode' | 'showCaption' | 'imageRotation' | 'imageScale'> => ({
  image: logo(file),
  imageMode: 'contain',
  showCaption: false,
  imageRotation,
  imageScale,
})

export const eventImages = {
  dice: diceChat,
  buy: buyIcon,
  money: moneyIcon,
  chat: chatIcon,
  thinkingBuy: thinkingBuyIcon,
  trade: tradeIcon,
  gavel: gavelIcon,
  star: starIcon,
  allStar: allStarIcon,
  lock: lockIcon,
  jail: jailIcon,
  jackpotChat: jackpotChatIcon,
  diamond: logo(logoFiles.diamond),
  question: logo(logoFiles.question),
  tax: logo(logoFiles.tax),
}

export const initialPlayers: Player[] = [
  {
    id: 'harumo',
    name: 'Harumo',
    color: '#ff4657',
    avatar: 'H',
    money: 15000,
    position: 0,
    lastDelta: 0,
  },
  {
    id: 'bups',
    name: 'bups1kitty',
    color: '#28a8ff',
    avatar: 'B',
    money: 15000,
    position: 0,
    lastDelta: 0,
  },
  {
    id: 'nikita',
    name: 'Никита',
    color: '#84d64a',
    avatar: 'Н',
    money: 15000,
    position: 0,
    lastDelta: 0,
  },
  {
    id: 'maxim',
    name: 'Максим',
    color: '#b36be8',
    avatar: 'М',
    money: 15000,
    position: 0,
    lastDelta: 0,
  },
]

export const tiles: Tile[] = [
  { id: 0, name: 'Старт', type: 'start', label: 'СТАРТ', image: rocketMap, imageMode: 'cover' },
  {
    id: 1,
    name: 'Balenciaga',
    type: 'brand',
    price: 600,
    rent: 20,
    rentLevels: [20, 100, 300, 900, 1600, 2500],
    group: 'fashion',
    ...brandArt(logoFiles.balenciaga, 0, 1.75),
  },
  {
    id: 2,
    name: 'Вопросик',
    type: 'chance',
    label: 'ВОПРОСИК',
    ...brandArt(logoFiles.question, 0, 1.08),
    showCaption: true,
  },
  { id: 3, name: 'Louis Vuitton', type: 'brand', price: 600, rent: 40, rentLevels: [40, 200, 600, 1800, 3200, 4500], group: 'fashion', ...brandArt(logoFiles.louisVuitton) },
  { id: 4, name: 'Налог', type: 'tax', label: 'НАЛОГ', ...brandArt(logoFiles.tax, 0, 1.42), showCaption: true },
  { id: 5, name: 'Tesla', type: 'brand', price: 2000, rentMode: 'fleet-multiplier', group: 'automotive', ...brandArt(logoFiles.tesla) },
  { id: 6, name: 'Nike', type: 'brand', price: 1000, rent: 60, rentLevels: [60, 300, 900, 2700, 4000, 5500], group: 'sportswear', ...brandArt(logoFiles.nike) },
  {
    id: 7,
    name: 'Вопросик',
    type: 'chance',
    label: 'ВОПРОСИК',
    ...brandArt(logoFiles.question, 0, 1.08),
    showCaption: true,
  },
  { id: 8, name: 'Adidas', type: 'brand', price: 1000, rent: 60, rentLevels: [60, 300, 900, 2700, 4000, 5500], group: 'sportswear', ...brandArt(logoFiles.adidas) },
  { id: 9, name: 'Kari', type: 'brand', price: 1200, rent: 80, rentLevels: [80, 400, 1000, 3000, 4500, 6000], group: 'sportswear', ...brandArt(logoFiles.kari) },
  { id: 10, name: 'Тюрьма', type: 'jail', label: 'ТЮРЬМА', image: policeMap, imageMode: 'cover' },
  { id: 11, name: 'Steam', type: 'brand', price: 1400, rent: 100, rentLevels: [100, 500, 1500, 4500, 6250, 7500], group: 'gaming', ...brandArt(logoFiles.steam, 90, 1.45) },
  { id: 12, name: 'Netflix', type: 'brand', price: 1500, rentMode: 'dice-multiplier', group: 'streaming', ...brandArt(logoFiles.netflix, 90, 1.45) },
  { id: 13, name: 'Epic Games', type: 'brand', price: 1400, rent: 100, rentLevels: [100, 500, 1500, 4500, 6250, 7500], group: 'gaming', ...brandArt(logoFiles.epicGames, 90, 1.45) },
  { id: 14, name: 'Electronic Arts', type: 'brand', price: 1600, rent: 120, rentLevels: [120, 600, 1800, 5000, 7000, 9000], group: 'gaming', ...brandArt(logoFiles.electronicArts, 90, 1.45) },
  { id: 15, name: 'Porsche', type: 'brand', price: 2000, rentMode: 'fleet-multiplier', group: 'automotive', ...brandArt(logoFiles.porsche, 90, 1.18) },
  { id: 16, name: 'Google', type: 'brand', price: 1800, rent: 140, rentLevels: [140, 700, 2000, 5500, 7500, 9500], group: 'big-tech', ...brandArt(logoFiles.google, 90, 1.45) },
  {
    id: 17,
    name: 'Вопросик',
    type: 'chance',
    label: 'ВОПРОСИК',
    ...brandArt(logoFiles.question, 90, 1.02),
    showCaption: true,
  },
  { id: 18, name: 'Microsoft', type: 'brand', price: 1800, rent: 140, rentLevels: [140, 700, 2000, 5500, 7500, 9500], group: 'big-tech', ...brandArt(logoFiles.microsoft, 90, 1.45) },
  { id: 19, name: 'Amazon', type: 'brand', price: 2000, rent: 160, rentLevels: [160, 800, 2200, 6000, 8000, 10000], group: 'big-tech', ...brandArt(logoFiles.amazon, 90, 1.45) },
  { id: 20, name: 'Казино', type: 'casino', label: 'КАЗИНО', image: jackpotMap, imageMode: 'cover' },
  { id: 21, name: 'ChatGPT', type: 'brand', price: 2200, rent: 180, rentLevels: [180, 900, 2500, 7000, 8750, 10500], group: 'ai', ...brandArt(logoFiles.chatGpt, 0, 1.55) },
  { id: 22, name: 'Налог', type: 'tax', label: 'НАЛОГ', ...brandArt(logoFiles.tax, 0, 1.42), showCaption: true },
  { id: 23, name: 'Claude', type: 'brand', price: 2200, rent: 180, rentLevels: [180, 900, 2500, 7000, 8750, 10500], group: 'ai', ...brandArt(logoFiles.claude, 90, 1.45) },
  { id: 24, name: 'Grok', type: 'brand', price: 2400, rent: 200, rentLevels: [200, 1000, 3000, 7500, 9250, 11000], group: 'ai', ...brandArt(logoFiles.grok, 90, 1.45) },
  { id: 25, name: 'Bentley', type: 'brand', price: 2000, rentMode: 'fleet-multiplier', group: 'automotive', ...brandArt(logoFiles.bentley, 0, 1.55) },
  { id: 26, name: 'Fanvue', type: 'brand', price: 2600, rent: 220, rentLevels: [220, 1100, 3300, 8000, 9750, 11500], group: 'creators', ...brandArt(logoFiles.fanvue, 0, 1.65) },
  { id: 27, name: 'Fansly', type: 'brand', price: 2600, rent: 220, rentLevels: [220, 1100, 3300, 8000, 9750, 11500], group: 'creators', ...brandArt(logoFiles.fansly, 0, 1.8) },
  { id: 28, name: 'Apple TV+', type: 'brand', price: 1500, rentMode: 'dice-multiplier', group: 'streaming', ...brandArt(logoFiles.appleTv, 0, 1.7) },
  { id: 29, name: 'OnlyFans', type: 'brand', price: 2800, rent: 240, rentLevels: [240, 1200, 3600, 8500, 10250, 12000], group: 'creators', ...brandArt(logoFiles.onlyFans, 0, 2) },
  { id: 30, name: 'Полиция', type: 'police', label: 'ПОЛИЦИЯ', image: policeMan, imageMode: 'cover' },
  { id: 31, name: 'Instagram', type: 'brand', price: 3000, rent: 260, rentLevels: [260, 1300, 3900, 9000, 11000, 12750], group: 'social', ...brandArt(logoFiles.instagram, 90, 1.45) },
  { id: 32, name: 'Reddit', type: 'brand', price: 3000, rent: 260, rentLevels: [260, 1300, 3900, 9000, 11000, 12750], group: 'social', ...brandArt(logoFiles.reddit, 90, 1.45) },
  {
    id: 33,
    name: 'Вопросик',
    type: 'chance',
    label: 'ВОПРОСИК',
    ...brandArt(logoFiles.question, -90, 1.02),
    showCaption: true,
  },
  { id: 34, name: 'TikTok', type: 'brand', price: 3200, rent: 280, rentLevels: [280, 1500, 4500, 10000, 12000, 14000], group: 'social', ...brandArt(logoFiles.tikTok, 90, 1.45) },
  { id: 35, name: 'Rolls-Royce', type: 'brand', price: 2000, rentMode: 'fleet-multiplier', group: 'automotive', ...brandArt(logoFiles.rollsRoyce, 90, 1.18) },
  {
    id: 36,
    name: 'Алмазик',
    type: 'diamond',
    label: 'АЛМАЗИК',
    ...brandArt(logoFiles.diamond, -90, 1.18),
  },
  {
    id: 37,
    name: 'NASA',
    type: 'brand',
    price: 3500,
    rent: 350,
    rentLevels: [350, 1750, 5000, 11000, 13000, 15000],
    group: 'space',
    ...brandArt(logoFiles.nasa, 90, 1.45),
  },
  {
    id: 38,
    name: 'Вопросик',
    type: 'chance',
    label: 'ВОПРОСИК',
    ...brandArt(logoFiles.question, -90, 1.02),
    showCaption: true,
  },
  {
    id: 39,
    name: 'SpaceX',
    type: 'brand',
    price: 4000,
    rent: 500,
    rentLevels: [500, 2000, 6000, 14000, 17000, 20000],
    group: 'space',
    ...brandArt(logoFiles.spaceX, 90, 1.7),
  },
]

export const groupColors: Record<string, string> = {
  automotive: '#d84252',
  'big-tech': '#2f7fd3',
  creators: '#e8792c',
  streaming: '#a42228',
  social: '#8a58cc',
  fashion: '#cf3f8b',
  sportswear: '#e2ad1f',
  space: '#2f75c9',
  ai: '#79a943',
  gaming: '#2fbca8',
}

export const groupLabels: Record<string, string> = {
  automotive: 'Машины',
  'big-tech': 'Big-Tech',
  creators: '18+',
  streaming: 'Стриминг',
  social: 'Социальные сети',
  fashion: 'Одежда',
  sportswear: 'Обувь',
  space: 'Космос',
  ai: 'ИИ',
  gaming: 'Игры',
}
