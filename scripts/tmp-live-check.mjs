import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
const page = await context.newPage()
const wsLog = []
page.on('websocket', ws => {
  const entry = { url: ws.url(), frames: [] }
  wsLog.push(entry)
  ws.on('framesent', e => { if (entry.frames.length < 40) entry.frames.push({ dir: 'sent', payload: String(e.payload).slice(0, 300) }) })
  ws.on('framereceived', e => { if (entry.frames.length < 40) entry.frames.push({ dir: 'recv', payload: String(e.payload).slice(0, 300) }) })
})
page.on('console', msg => { if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200)) })

await page.goto('http://127.0.0.1:5173/situation')
console.log('WAITING_FOR_LOGIN url=', page.url())
const start = Date.now()
while (Date.now() - start < 180_000) {
  if (!page.url().includes('/login')) break
  await page.waitForTimeout(1000)
}
console.log('AFTER_LOGIN url=', page.url())
await page.waitForTimeout(2000)
await page.goto('http://127.0.0.1:5173/situation')
await page.waitForTimeout(12000)
await page.screenshot({ path: 'output/live-situation.png' })
console.log('WS_CONNECTIONS=', JSON.stringify(wsLog.map(w => ({ url: w.url, frames: w.frames.length }))))
const samples = wsLog.flatMap(w => w.frames).filter(f => f.payload.includes('ENGINE_FRAME'))
console.log('ENGINE_FRAMES=', samples.length, samples[0]?.payload?.slice(0, 300) ?? '')
await browser.close()
