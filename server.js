import 'dotenv/config'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { authenticate } from './middleware/auth.js'
import { closePool, runMigrations } from './db/index.js'
import { closeCache } from './db/cache.js'
import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import providerRoutes, { adminProviderRoutes } from './routes/providers.js'
import settingsRoutes from './routes/settings.js'
import skillRoutes, { adminSkillRoutes } from './routes/skills.js'
import adminRoutes from './routes/admin.js'
import codeReviewRoutes from './routes/code-review.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: false })

await runMigrations()

// ── 插件注册 ────────────────────────────────────────────
await app.register(fastifyCors, { origin: '*' })
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'change-me-dev-secret',
})
app.decorate('authenticate', authenticate)
await app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
  setHeaders(res, pathName) {
    if (pathName.includes('/vendor/')) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
    }
  },
})

// uploads 目录
const UPLOADS_DIR = join(__dirname, 'uploads')
mkdirSync(UPLOADS_DIR, { recursive: true })
await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: '/uploads/',
  decorateReply: false,
})

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(providerRoutes, { prefix: '/api/providers' })
await app.register(adminProviderRoutes, { prefix: '/api/admin/providers' })
await app.register(conversationRoutes, { prefix: '/api/conversations' })
await app.register(messageRoutes, { prefix: '/api' })
await app.register(skillRoutes, { prefix: '/api/skills' })
await app.register(adminSkillRoutes, { prefix: '/api/admin/skills' })
await app.register(adminRoutes, { prefix: '/api/admin' })
await app.register(settingsRoutes, { prefix: '/api/settings' })
await app.register(codeReviewRoutes, { prefix: '/api/code-review' })

// ── 启动 ────────────────────────────────────────────────
const PORT = process.env.PORT || 3131
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`✅  算法助手 running at http://0.0.0.0:${PORT}`)
} catch (err) {
  console.error(err)
  process.exit(1)
}

process.on('SIGINT', async () => {
  await closeCache()
  await closePool()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await closeCache()
  await closePool()
  process.exit(0)
})
