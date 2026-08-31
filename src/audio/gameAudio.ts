const soundUrls = {
  turn: new URL('../assets/audio/turn-start.wav', import.meta.url).href,
  trade: new URL('../assets/audio/trade-request.wav', import.meta.url).href,
  warning: new URL('../assets/audio/turn-warning.wav', import.meta.url).href,
} as const

const soundVolumes: Record<GameSound, number> = {
  turn: 0.58,
  trade: 0.64,
  warning: 0.68,
}

export type GameSound = keyof typeof soundUrls

let audioContext: AudioContext | null = null
let audioWasUnlocked = false
let pendingSound: GameSound | null = null
const buffers = new Map<GameSound, AudioBuffer>()
const bufferPromises = new Map<GameSound, Promise<AudioBuffer | null>>()

const getAudioContext = () => {
  if (!audioContext) audioContext = new AudioContext()
  return audioContext
}

const loadBuffer = (sound: GameSound) => {
  const loaded = buffers.get(sound)
  if (loaded) return Promise.resolve(loaded)

  const existingPromise = bufferPromises.get(sound)
  if (existingPromise) return existingPromise

  const context = getAudioContext()
  const promise = fetch(soundUrls[sound])
    .then((response) => {
      if (!response.ok) throw new Error(`Audio request failed: ${response.status}`)
      return response.arrayBuffer()
    })
    .then((data) => context.decodeAudioData(data))
    .then((buffer) => {
      buffers.set(sound, buffer)
      return buffer
    })
    .catch(() => null)

  bufferPromises.set(sound, promise)
  return promise
}

const startSound = async (sound: GameSound) => {
  const context = getAudioContext()
  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined)
  }
  if (context.state !== 'running') {
    pendingSound = sound
    return
  }

  const buffer = await loadBuffer(sound)
  if (!buffer || context.state !== 'running') {
    pendingSound = sound
    return
  }

  const source = context.createBufferSource()
  const gain = context.createGain()
  gain.gain.value = soundVolumes[sound]
  source.buffer = buffer
  source.connect(gain)
  gain.connect(context.destination)
  source.addEventListener('ended', () => {
    source.disconnect()
    gain.disconnect()
  }, { once: true })
  source.start()
}

export const unlockGameAudio = () => {
  audioWasUnlocked = true
  const context = getAudioContext()
  void context.resume().then(() => {
    Object.keys(soundUrls).forEach((sound) => void loadBuffer(sound as GameSound))
    if (pendingSound) {
      const sound = pendingSound
      pendingSound = null
      void startSound(sound)
    }
  }).catch(() => undefined)
}

export const playGameSound = (sound: GameSound) => {
  if (!audioWasUnlocked) {
    pendingSound = sound
    return
  }
  void startSound(sound)
}
