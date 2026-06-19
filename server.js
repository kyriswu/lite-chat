import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import fastifyCors from '@fastify/cors'
import { createReadStream, createWriteStream, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: false })

// ── 插件注册 ────────────────────────────────────────────
await app.register(fastifyCors, { origin: '*' })
await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } }) // 20MB
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

// ── 图片上传 ────────────────────────────────────────────
app.post('/api/upload', async (req, reply) => {
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

// ── 代理：模型列表 ────────────────────────────────────────
app.get('/api/models', async (req, reply) => {
  const baseUrl = req.headers['x-base-url'] || 'http://localhost:11434'
  const apiKey  = req.headers['x-api-key'] || ''

  // 同时尝试 Ollama 和 OpenAI 风格
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  try {
    // 先试 OpenAI 风格 /v1/models
    const res = await fetch(`${baseUrl}/v1/models`, { headers })
    if (res.ok) {
      const data = await res.json()
      // 标准 OpenAI 返回 { data: [{id, ...}] }
      const models = (data.data || data.models || []).map(m => m.id || m.name)
      return { models }
    }
  } catch (_) {}

  try {
    // 再试 Ollama 风格 /api/tags
    const res = await fetch(`${baseUrl}/api/tags`, { headers })
    if (res.ok) {
      const data = await res.json()
      const models = (data.models || []).map(m => m.name)
      return { models }
    }
  } catch (_) {}

  return reply.code(502).send({ error: 'Cannot reach backend API' })
})

// ── 代理：流式聊天（SSE 透传）──────────────────────────────
app.post('/api/chat', async (req, reply) => {
  const { messages, model, stream = true } = req.body
  const baseUrl = req.headers['x-base-url'] || 'http://localhost:11434'
  const apiKey  = req.headers['x-api-key'] || ''

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const payload = JSON.stringify({ model, messages, stream })

  let upstreamRes
  try {
    upstreamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
    })
  } catch (err) {
    return reply.code(502).send({ error: `Network error: ${err.message}` })
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text()
    return reply.code(upstreamRes.status).send({ error: text })
  }

  // 流式透传 SSE
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  })

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      reply.raw.write(decoder.decode(value, { stream: true }))
    }
  } finally {
    reply.raw.end()
  }
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
