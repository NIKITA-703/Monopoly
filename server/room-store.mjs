import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const roomCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const roomCodeLength = 6
const maximumRoomPlayers = 5

const normalizeCode = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

const normalizeRoomName = (value) => {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
  return name || 'Комната Monopoly'
}

const createPasswordHash = (password) => {
  const normalized = String(password ?? '')
  if (!normalized) return null
  const salt = randomBytes(16)
  const digest = scryptSync(normalized, salt, 32)
  return `${salt.toString('hex')}:${digest.toString('hex')}`
}

const verifyPasswordHash = (password, storedValue) => {
  if (!storedValue) return true
  const [saltHex, digestHex] = String(storedValue).split(':')
  if (!saltHex || !digestHex) return false
  try {
    const expected = Buffer.from(digestHex, 'hex')
    const actual = scryptSync(String(password ?? ''), Buffer.from(saltHex, 'hex'), expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

const createCode = () => {
  const bytes = randomBytes(roomCodeLength)
  return [...bytes].map((value) => roomCodeAlphabet[value % roomCodeAlphabet.length]).join('')
}

export const installRoomSchema = (database) => {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'playing')),
      leader_token TEXT NOT NULL,
      game_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      seat INTEGER NOT NULL CHECK (seat >= 0 AND seat < 5),
      ready INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, session_token),
      UNIQUE (room_id, seat),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms (status);
    CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members (room_id, seat);
  `)
}

export const createRoomStore = (database, options = {}) => {
  const now = options.now ?? (() => Date.now())
  const generateCode = options.generateCode ?? createCode

  const findRoomByCode = (code) => database.prepare(`
    SELECT id, code, name, visibility, password_hash, status, leader_token, game_id, created_at, updated_at
    FROM rooms
    WHERE code = ?
  `).get(normalizeCode(code))

  const getRoom = (roomId) => database.prepare(`
    SELECT id, code, name, visibility, password_hash, status, leader_token, game_id, created_at, updated_at
    FROM rooms
    WHERE id = ?
  `).get(roomId)

  const getMembership = (sessionToken) => database.prepare(`
    SELECT room_id, session_token, seat, ready, joined_at, last_active_at
    FROM room_members
    WHERE session_token = ?
  `).get(sessionToken)

  const listMembers = (roomId) => database.prepare(`
    SELECT room_id, session_token, seat, ready, joined_at, last_active_at
    FROM room_members
    WHERE room_id = ?
    ORDER BY seat
  `).all(roomId)

  const nextFreeSeat = (roomId) => {
    const occupied = new Set(listMembers(roomId).map((member) => member.seat))
    for (let seat = 0; seat < maximumRoomPlayers; seat += 1) {
      if (!occupied.has(seat)) return seat
    }
    return null
  }

  const createRoom = ({ leaderToken, name, visibility = 'private', password = '' }) => {
    if (typeof leaderToken !== 'string' || !leaderToken) throw new Error('invalid_session')
    if (getMembership(leaderToken)) throw new Error('already_in_room')
    if (visibility !== 'public' && visibility !== 'private') throw new Error('invalid_visibility')

    let code = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = normalizeCode(generateCode())
      if (candidate.length === roomCodeLength && !findRoomByCode(candidate)) {
        code = candidate
        break
      }
    }
    if (!code) throw new Error('room_code_unavailable')

    const roomId = randomUUID()
    const timestamp = now()
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        INSERT INTO rooms (
          id, code, name, visibility, password_hash, status, leader_token, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'lobby', ?, ?, ?)
      `).run(
        roomId,
        code,
        normalizeRoomName(name),
        visibility,
        createPasswordHash(password),
        leaderToken,
        timestamp,
        timestamp,
      )
      database.prepare(`
        INSERT INTO room_members (room_id, session_token, seat, ready, joined_at, last_active_at)
        VALUES (?, ?, 0, 0, ?, ?)
      `).run(roomId, leaderToken, timestamp, timestamp)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return getRoom(roomId)
  }

  const joinRoom = ({ sessionToken, code, password = '' }) => {
    if (typeof sessionToken !== 'string' || !sessionToken) throw new Error('invalid_session')
    const existingMembership = getMembership(sessionToken)
    const room = findRoomByCode(code)
    if (!room) throw new Error('room_not_found')
    if (existingMembership?.room_id === room.id) return existingMembership
    if (existingMembership) throw new Error('already_in_room')
    if (room.status !== 'lobby') throw new Error('room_already_playing')
    if (!verifyPasswordHash(password, room.password_hash)) throw new Error('invalid_room_password')

    const seat = nextFreeSeat(room.id)
    if (seat === null) throw new Error('room_full')
    const timestamp = now()
    database.prepare(`
      INSERT INTO room_members (room_id, session_token, seat, ready, joined_at, last_active_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(room.id, sessionToken, seat, timestamp, timestamp)
    database.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(timestamp, room.id)
    return getMembership(sessionToken)
  }

  return {
    createRoom,
    findRoomByCode,
    getMembership,
    getRoom,
    joinRoom,
    listMembers,
    verifyRoomPassword: (room, password) => verifyPasswordHash(password, room?.password_hash),
  }
}

export const roomStoreConstants = {
  codeLength: roomCodeLength,
  maximumPlayers: maximumRoomPlayers,
}
