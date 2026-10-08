import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { makeApp } from './app.ts'

const port = Number(process.env.PORT ?? 3001)
const { app: api, runtime } = makeApp({
  db: { file: process.env.DB_FILE ?? 'data/saasly.db', seed: process.env.RESEED === '1' },
  chaos: { latencyMs: Number(process.env.API_LATENCY_MS ?? 250), failRate: Number(process.env.API_FAIL_RATE ?? 0) },
})

const app = new Hono()
app.route('/', api)
// In production, also serve the built SPA (with history-API fallback).
if (process.env.SERVE_STATIC === '1') {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`API listening on http://localhost:${info.port}`))
const shutdown = () => server.close(() => void runtime.dispose().then(() => process.exit(0)))
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
