import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { one, query, withTransaction } from '../db/index.js'
import { cacheDelPattern, cacheGetJson, cacheSetJson } from '../db/cache.js'
import { requireAdmin } from '../middleware/auth.js'

function key() {
  return createHash('sha256').update(process.env.API_KEY_ENCRYPTION_SECRET || 'change-me-32-byte-secret').digest()
}

export function encryptApiKey(value) {
  if (!value) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':')
}

export function decryptApiKey(value) {
  if (!value) return ''
  const [iv, tag, encrypted] = value.split(':').map((part) => Buffer.from(part, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function publicProvider(row) {
  const isGlobal = Boolean(row.is_global || row.user_id === null)
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    providerType: row.provider_type,
    apiFormat: row.api_format || 'openai_chat_completions',
    defaultModel: row.default_model,
    isDefault: row.is_default,
    isGlobal,
    hasApiKey: Boolean(row.api_key_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function v1BaseUrl(baseUrl) {
  const trimmed = trimBaseUrl(baseUrl)
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

export function chatCompletionsUrl(baseUrl) {
  return `${v1BaseUrl(baseUrl)}/chat/completions`
}

export function responsesUrl(baseUrl) {
  return `${v1BaseUrl(baseUrl)}/responses`
}

async function loadProviderModels(provider) {
  const baseUrl = trimBaseUrl(provider.base_url)
  const apiKey = provider.api_key_ciphertext ? decryptApiKey(provider.api_key_ciphertext) : ''
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const urls = baseUrl.endsWith('/v1')
    ? [`${baseUrl}/models`]
    : [`${baseUrl}/v1/models`, `${baseUrl}/models`]

  let lastStatus = 502
  for (const url of urls) {
    const resp = await fetch(url, { headers })
    lastStatus = resp.status
    if (!resp.ok) continue
    const json = await resp.json()
    return (json.data || json.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name || ''))
      .filter(Boolean)
  }

  const error = new Error(`Upstream ${lastStatus}`)
  error.statusCode = lastStatus
  throw error
}

function normalizeProviderInput(body = {}, existing = null) {
  return {
    name: Object.hasOwn(body, 'name') ? String(body.name || '').trim() : existing?.name,
    baseUrl: Object.hasOwn(body, 'baseUrl') ? String(body.baseUrl || '').trim() : existing?.base_url,
    providerType: Object.hasOwn(body, 'providerType') ? body.providerType || 'openai_compatible' : existing?.provider_type || 'openai_compatible',
    apiFormat: Object.hasOwn(body, 'apiFormat') ? body.apiFormat || 'openai_chat_completions' : existing?.api_format || 'openai_chat_completions',
    defaultModel: Object.hasOwn(body, 'defaultModel') ? body.defaultModel || null : existing?.default_model || null,
    isDefault: Object.hasOwn(body, 'isDefault') ? Boolean(body.isDefault) : Boolean(existing?.is_default),
  }
}

export default async function providerRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => {
    const cached = await cacheGetJson('providers:public')
    if (cached) return cached
    const result = await query(
      `SELECT * FROM providers
       WHERE user_id IS NULL OR is_global = true
       ORDER BY is_default DESC, created_at ASC`,
    )
    const payload = { providers: result.rows.map(publicProvider) }
    await cacheSetJson('providers:public', payload, 60)
    return payload
  })

  app.get('/:id/models', async (request, reply) => {
    const existing = await one(
      `SELECT * FROM providers
       WHERE id = $1 AND (user_id = $2 OR user_id IS NULL OR is_global = true)`,
      [request.params.id, request.user.id],
    )
    if (!existing) return reply.code(404).send({ error: 'Provider not found' })

    try {
      return { models: await loadProviderModels(existing) }
    } catch (err) {
      return reply.code(err.statusCode || 502).send({ error: err.message })
    }
  })
}

export async function adminProviderRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const cached = await cacheGetJson('providers:admin')
    if (cached) return cached
    const result = await query(
      `SELECT * FROM providers
       WHERE user_id IS NULL OR is_global = true
       ORDER BY created_at ASC`,
    )
    const payload = { providers: result.rows.map(publicProvider) }
    await cacheSetJson('providers:admin', payload, 60)
    return payload
  })

  app.post('/', async (request, reply) => {
    const body = request.body || {}
    const input = normalizeProviderInput(body)
    if (!input.name || !input.baseUrl) return reply.code(400).send({ error: 'Name and base URL are required' })

    const result = await query(
      `INSERT INTO providers (user_id, name, base_url, api_key_ciphertext, provider_type, api_format, default_model, is_default, is_global)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, false, true)
       RETURNING *`,
      [
        input.name,
        input.baseUrl,
        encryptApiKey(String(body.apiKey || '').trim()),
        input.providerType,
        input.apiFormat,
        input.defaultModel,
      ],
    )
    await cacheDelPattern('providers:*')
    return reply.code(201).send({ provider: publicProvider(result.rows[0]) })
  })

  app.patch('/:id', async (request, reply) => {
    const existing = await one(
      'SELECT * FROM providers WHERE id = $1 AND (user_id IS NULL OR is_global = true)',
      [request.params.id],
    )
    if (!existing) return reply.code(404).send({ error: 'Provider not found' })

    const body = request.body || {}
    const input = normalizeProviderInput(body, existing)
    if (!input.name || !input.baseUrl) return reply.code(400).send({ error: 'Name and base URL are required' })
    const apiKeyCiphertext = Object.hasOwn(body, 'apiKey')
      ? encryptApiKey(String(body.apiKey || '').trim())
      : existing.api_key_ciphertext

    const result = await query(
      `UPDATE providers
       SET user_id = NULL,
           name = $2,
           base_url = $3,
           api_key_ciphertext = $4,
           provider_type = $5,
           api_format = $6,
           default_model = $7,
           is_default = false,
           is_global = true,
           updated_at = now()
       WHERE id = $1 AND (user_id IS NULL OR is_global = true)
       RETURNING *`,
      [request.params.id, input.name, input.baseUrl, apiKeyCiphertext, input.providerType, input.apiFormat, input.defaultModel],
    )
    await cacheDelPattern('providers:*')
    return { provider: publicProvider(result.rows[0]) }
  })

  app.get('/:id/models', async (request, reply) => {
    const existing = await one(
      'SELECT * FROM providers WHERE id = $1 AND (user_id IS NULL OR is_global = true)',
      [request.params.id],
    )
    if (!existing) return reply.code(404).send({ error: 'Provider not found' })

    try {
      return { models: await loadProviderModels(existing) }
    } catch (err) {
      return reply.code(err.statusCode || 502).send({ error: err.message })
    }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query(
      'DELETE FROM providers WHERE id = $1 AND (user_id IS NULL OR is_global = true)',
      [request.params.id],
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'Provider not found' })
    await cacheDelPattern('providers:*')
    return { ok: true }
  })
}
