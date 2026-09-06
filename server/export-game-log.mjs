import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const dataDirectory = process.env.DATA_DIR ? normalize(process.env.DATA_DIR) : join(rootDirectory, 'data')
const auditDirectory = join(dataDirectory, 'audit')
const gameId = String(process.argv[2] ?? '').trim()

if (!gameId) {
  console.error('Укажите ID партии: npm run logs:game -- <game-id>')
  process.exit(1)
}

if (!existsSync(auditDirectory)) {
  console.error(`Каталог журнала ещё не создан: ${auditDirectory}`)
  process.exit(1)
}

const files = readdirSync(auditDirectory)
  .filter((name) => /^game-actions\.jsonl(?:\.\d+)?$/.test(name))
  .sort((left, right) => {
    const index = (name) => Number(name.split('.').at(-1)) || 0
    return index(right) - index(left)
  })

let matches = 0
for (const file of files) {
  const lines = readFileSync(join(auditDirectory, file), 'utf8').split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (record.gameId !== gameId) continue
      process.stdout.write(`${JSON.stringify(record)}\n`)
      matches += 1
    } catch {
      // Повреждённая отдельная строка не должна мешать выгрузке остальных записей.
    }
  }
}

if (matches === 0) {
  console.error(`Для партии ${gameId} записей не найдено.`)
  process.exitCode = 1
}
