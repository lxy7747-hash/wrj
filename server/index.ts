import { createMockServer } from './app.js'

const configuredPort = process.env.MOCK_PORT ?? '4173'
const port = Number(configuredPort)

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError('MOCK_PORT must be an integer from 1 through 65535.')
}

const server = createMockServer({ port })
server.httpServer.once('listening', () => {
  console.log(`Deterministic mock listening on http://127.0.0.1:${port}`)
})
