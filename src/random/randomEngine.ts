import type { DiceRoll, EntropySample } from '../types'

const FALLBACK_TIMEOUT = 1600

type WeatherStation = {
  name: string
  latitude: number
  longitude: number
}

const weatherStations: WeatherStation[] = [
  { name: 'Москва', latitude: 55.75, longitude: 37.62 },
  { name: 'Нью-Йорк', latitude: 40.71, longitude: -74.01 },
  { name: 'Токио', latitude: 35.68, longitude: 139.76 },
  { name: 'Рейкьявик', latitude: 64.14, longitude: -21.9 },
  { name: 'Сидней', latitude: -33.87, longitude: 151.21 },
  { name: 'Каир', latitude: 30.04, longitude: 31.24 },
  { name: 'Буэнос-Айрес', latitude: -34.61, longitude: -58.38 },
  { name: 'Кейптаун', latitude: -33.93, longitude: 18.42 },
  { name: 'Анкоридж', latitude: 61.22, longitude: -149.9 },
  { name: 'Дубай', latitude: 25.2, longitude: 55.27 },
]

const fallback = (source: string, label: string, value: number): EntropySample => ({
  source,
  label,
  value,
  status: 'fallback',
})

const live = (source: string, label: string, value: number): EntropySample => ({
  source,
  label,
  value,
  status: 'live',
})

const timeoutSignal = () => {
  const controller = new AbortController()
  window.setTimeout(() => controller.abort(), FALLBACK_TIMEOUT)
  return controller.signal
}

const stableHash = (input: string) => {
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

const xorshift = (value: number) => {
  let next = value >>> 0
  next ^= next << 13
  next ^= next >>> 17
  next ^= next << 5
  return next >>> 0
}

const toUint = (value: number) => Math.trunc(Math.abs(value)) >>> 0

const pickWeatherStation = () => {
  const bucket = new Uint32Array(1)
  window.crypto.getRandomValues(bucket)
  return weatherStations[bucket[0] % weatherStations.length]
}

const fromCrypto = (): EntropySample => {
  const bucket = new Uint32Array(4)
  window.crypto.getRandomValues(bucket)
  const value = bucket.reduce((sum, item, index) => sum ^ (item >>> index), 0)
  return live('browser.crypto', 'crypto.getRandomValues', value >>> 0)
}

const fromPerformance = (): EntropySample => {
  let value = 0

  for (let index = 0; index < 72; index += 1) {
    const start = performance.now()
    const jitter = Math.round((performance.now() - start + performance.now()) * 100000)
    value ^= jitter + index * 2654435761
  }

  return live('local.performance', 'микро-задержки браузера', value >>> 0)
}

const fromLocalMemory = (): EntropySample => {
  const memory = 'memory' in performance ? performance.memory : undefined
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number }
  const value =
    typeof memory === 'object' && memory !== null
      ? stableHash(JSON.stringify(memory))
      : stableHash(
          [
            navigator.hardwareConcurrency,
            navigatorWithMemory.deviceMemory ?? 'unknown',
            screen.width,
            screen.height,
            window.innerWidth,
            window.innerHeight,
            Date.now(),
          ].join('|'),
        )

  return live('local.machine', 'память/экран/ПК', value)
}

const fromCryptoMarkets = async (): Promise<EntropySample[]> => {
  const assets = [
    { id: 'bitcoin', label: 'BTC/USD' },
    { id: 'ethereum', label: 'ETH/USD' },
    { id: 'solana', label: 'SOL/USD' },
  ]

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${assets
        .map((asset) => asset.id)
        .join(',')}&vs_currencies=usd`,
      { signal: timeoutSignal() },
    )
    const json = await response.json()

    return assets.map((asset) => {
      const value = Math.round(Number(json[asset.id].usd) * 100)

      if (!Number.isFinite(value)) {
        throw new Error(`${asset.label} price is not numeric`)
      }

      return live(`coingecko.${asset.id}`, asset.label, value)
    })
  } catch {
    return assets.map((asset, index) =>
      fallback(
        `coingecko.${asset.id}`,
        `${asset.label} fallback`,
        stableHash(`${asset.id}|${Date.now()}|${performance.now()}|${index}`),
      ),
    )
  }
}

const fromCurrency = async (): Promise<EntropySample> => {
  try {
    const response = await fetch('/api/entropy/fx', {
      signal: timeoutSignal(),
    })
    const json = await response.json()
    const value = Math.round(Number(json.rates.EUR) * 1000000)

    if (!Number.isFinite(value)) {
      throw new Error('FX price is not numeric')
    }

    return live('frankfurter.fx', 'USD/EUR', value)
  } catch {
    return fallback('frankfurter.fx', 'USD/EUR fallback', performance.timeOrigin % 1000000)
  }
}

const fromTemperature = async (): Promise<EntropySample> => {
  const station = pickWeatherStation()

  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${station.latitude}&longitude=${station.longitude}&current=temperature_2m`,
      { signal: timeoutSignal() },
    )
    const json = await response.json()
    const value = Math.round(Number(json.current.temperature_2m) * 100)

    if (!Number.isFinite(value)) {
      throw new Error('Temperature is not numeric')
    }

    return live('open-meteo.weather', `температура: ${station.name}`, value)
  } catch {
    return fallback(
      'open-meteo.weather',
      `температура ${station.name} fallback`,
      stableHash(`${station.name}|${new Date().getMinutes()}|${Date.now()}`),
    )
  }
}

export const rollComplexDice = async (): Promise<DiceRoll> => {
  const cryptoMarkets = await fromCryptoMarkets()
  const samples = await Promise.all([
    Promise.resolve(fromCrypto()),
    Promise.resolve(fromPerformance()),
    Promise.resolve(fromLocalMemory()),
    ...cryptoMarkets.map((sample) => Promise.resolve(sample)),
    fromCurrency(),
    fromTemperature(),
  ])

  const mixedText = samples
    .map((sample, index) => `${index}:${sample.source}:${sample.value}:${sample.status}`)
    .join('|')

  const seed = stableHash(`${mixedText}|${Date.now()}|${performance.now()}`)
  const pool = samples.reduce((acc, sample, index) => {
    return xorshift(acc ^ stableHash(`${sample.source}:${sample.value}`) ^ toUint(sample.value + index * 9973))
  }, seed)
  const valueSum = samples.reduce((acc, sample, index) => acc + toUint(sample.value) * (index + 3), 0)
  const diceSalt = new Uint32Array(2)
  window.crypto.getRandomValues(diceSalt)
  const firstMix = xorshift(
    pool ^ toUint(samples[0].value) ^ toUint(samples[3].value) ^ diceSalt[0],
  )
  const secondMix = xorshift(
    valueSum ^ toUint(samples[samples.length - 1].value) ^ xorshift(seed) ^ diceSalt[1],
  )
  const dice: [number, number] = [(firstMix % 6) + 1, (secondMix % 6) + 1]

  return {
    dice,
    total: dice[0] + dice[1],
    seed,
    samples,
    formula:
      'FNV-1a(локальные источники + BTC/ETH/SOL + FX + случайный градусник + время) -> xorshift pool + независимые crypto-соли -> два кубика',
  }
}

export const randomIntInclusive = (minimum: number, maximum: number) => {
  const min = Math.ceil(Math.min(minimum, maximum))
  const max = Math.floor(Math.max(minimum, maximum))
  const range = max - min + 1
  const bucket = new Uint32Array(1)
  window.crypto.getRandomValues(bucket)
  return min + (bucket[0] % range)
}
