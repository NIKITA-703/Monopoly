import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const secretKeyPattern = /password|token|secret|cookie|authorization/i

const sanitize = (value, depth = 0) => {
  if (depth > 8) return '[depth-limit]'
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    secretKeyPattern.test(key) ? '[redacted]' : sanitize(item, depth + 1),
  ]))
}

export const createAuditLog = ({
  directory,
  debug = false,
  maxBytes = 5 * 1024 * 1024,
  maxFiles = 5,
  maxAgeDays = 14,
}) => {
  const auditDirectory = join(directory, 'audit')
  const logPath = join(auditDirectory, 'game-actions.jsonl')
  const sizeLimit = Math.max(64 * 1024, Number(maxBytes) || 5 * 1024 * 1024)
  const fileLimit = Math.max(2, Math.trunc(Number(maxFiles) || 5))
  const maxAgeMilliseconds = Math.max(1, Number(maxAgeDays) || 14) * 24 * 60 * 60 * 1000
  mkdirSync(auditDirectory, { recursive: true })

  const pruneExpired = () => {
    const expiresBefore = Date.now() - maxAgeMilliseconds
    for (const name of readdirSync(auditDirectory)) {
      if (!/^game-actions\.jsonl\.\d+$/.test(name)) continue
      const path = join(auditDirectory, name)
      if (statSync(path).mtimeMs < expiresBefore) unlinkSync(path)
    }
  }

  const rotate = () => {
    if (!existsSync(logPath) || statSync(logPath).size < sizeLimit) return
    const oldestPath = `${logPath}.${fileLimit - 1}`
    if (existsSync(oldestPath)) unlinkSync(oldestPath)
    for (let index = fileLimit - 2; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`
      if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`)
    }
    renameSync(logPath, `${logPath}.1`)
  }

  const write = (action, details = {}) => {
    const record = sanitize({
      time: new Date().toISOString(),
      recordId: randomUUID(),
      eventId: details.eventId ?? null,
      roomId: details.roomId ?? null,
      gameId: details.gameId ?? null,
      playerId: details.playerId ?? null,
      turnSequence: details.turnSequence ?? null,
      phase: details.phase ?? null,
      action,
      before: details.before ?? null,
      after: details.after ?? null,
      reason: details.reason ?? null,
      ...details,
    })
    try {
      pruneExpired()
      rotate()
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      console.error('Не удалось записать диагностический журнал:', error)
    }
    if (debug) console.log(JSON.stringify(record))
    return record.recordId
  }

  return { logPath, write }
}
