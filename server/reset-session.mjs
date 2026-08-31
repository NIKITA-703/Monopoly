import { mkdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const dataDirectory = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(rootDirectory, 'data')
mkdirSync(dataDirectory, { recursive: true })

const databasePath = join(dataDirectory, 'monopoly.sqlite')
const database = new DatabaseSync(databasePath)

try {
  database.exec('BEGIN IMMEDIATE')
  database.prepare("UPDATE games SET status = 'finished' WHERE status = 'playing'").run()
  database.prepare("UPDATE room SET status = 'lobby', game_id = NULL, countdown_ends_at = NULL WHERE id = 1").run()
  database.prepare('DELETE FROM sessions').run()
  database.exec('COMMIT')
  console.log(`Игровая сессия сброшена: ${databasePath}`)
  console.log('История игр и статистика попаданий сохранены.')
} catch (error) {
  try { database.exec('ROLLBACK') } catch {}
  console.error('Не удалось сбросить игровую сессию:', error)
  process.exitCode = 1
} finally {
  database.close()
}
