import 'dotenv/config'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import fastifyCors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import { createWriteStream, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { randomUUID } from 'crypto'
import { authenticate } from './middleware/auth.js'
import { closePool } from './db/index.js'
import authRoutes from './routes/auth.js'
import conversationRoutes from './routes/conversations.js'
import messageRoutes from './routes/messages.js'
import providerRoutes from './routes/providers.js'
import settingsRoutes from './routes/settings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: false })

// ── 插件注册 ────────────────────────────────────────────
await app.register(fastifyCors, { origin: '*' })
await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } }) // 20MB
await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'change-me-dev-secret',
})
app.decorate('authenticate', authenticate)
await app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
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
await app.register(conversationRoutes, { prefix: '/api/conversations' })
await app.register(messageRoutes, { prefix: '/api' })
await app.register(settingsRoutes, { prefix: '/api/settings' })

// ── 图片上传 ────────────────────────────────────────────
app.post('/api/upload', { preHandler: app.authenticate }, async (req, reply) => {
  const data = await req.file()
  if (!data) return reply.code(400).send({ error: 'No file' })

  const ext = data.filename.split('.').pop().toLowerCase()
  const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp']
  if (!allowed.includes(ext)) return reply.code(400).send({ error: 'Invalid file type' })

  const filename = `${randomUUID()}.${ext}`
  const dest = join(UPLOADS_DIR, filename)
  await pipeline(data.file, createWriteStream(dest))

  return { url: `/uploads/${filename}`, filename }
})

// ── 启动 ────────────────────────────────────────────────
const PORT = process.env.PORT || 3131
try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`✅  lite-chat running at http://0.0.0.0:${PORT}`)
} catch (err) {
  console.error(err)
  process.exit(1)
}

process.on('SIGINT', async () => {
  await closePool()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await closePool()
  process.exit(0)
})
