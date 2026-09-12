import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run via npm run test:static to build the production assets first.
const asset = readdirSync('dist/assets').find((name) => name.startsWith('Louis Vuitton-') && name.endsWith('.webp'))
assert.ok(asset, 'Production build must contain the Louis Vuitton logo')
const expected = readFileSync(join('dist/assets', asset))
const dataDirectory = mkdtempSync(join(tmpdir(), 'monopoly-static-'))
const port = 40000 + Math.floor(Math.random() * 10000)
const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDirectory },
  stdio: ['ignore', 'pipe', 'inherit'],
})

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000)
    server.once('error', reject)
    server.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Server exited: ${code}`))
    })
    server.stdout.on('data', (data) => {
      if (String(data).includes('Monopoly online server')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  const base = `http://127.0.0.1:${port}`
  for (const suffix of ['', '?v=regression']) {
    const response = await fetch(`${base}/assets/${encodeURIComponent(asset)}${suffix}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/webp')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  }
  for (const path of ['/assets/%ZZ.webp', '/assets/%00.webp']) {
    assert.equal((await fetch(`${base}${path}`)).status, 400)
  }
  assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 403)
  const home = await fetch(`${base}/`)
  assert.equal(home.status, 200)
  assert.match(home.headers.get('content-type'), /^text\/html/)
  assert.equal((await fetch(`${base}/api/health`)).status, 200)
  console.log('Static files integration: OK')
} finally {
  server.kill()
  if (server.exitCode === null && server.signalCode === null) await once(server, 'exit')
  rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
