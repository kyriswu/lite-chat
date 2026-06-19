import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { one, query, withTransaction } from '../db/index.js'
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
    defaultModel: row.default_model,
    isDefault: row.is_default,
    isGlobal,
    hasApiKey: Boolean(row.api_key_ciphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function loadModels(provider) {
  const headers = { 'Content-Type': 'application/json' }
  const apiKey = decryptApiKey(provider.api_key_ciphertext)
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const baseUrl = provider.base_url.replace(/\/+$/, '')

  try {
    const res = await fetch(`${baseUrl}/v1/models`, { headers })
    if (res.ok) {
      const data = await res.json()
      return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean)
    }
  } catch {}

  try {
    const res = await fetch(`${baseUrl}/api/tags`, { headers })
    if (res.ok) {
      const data = await res.json()
      return (data.models || []).map((m) => m.name).filter(Boolean)
    }
  } catch {}

  return null
}

function normalizeProviderInput(body = {}, existing = null) {
  return {
    name: Object.hasOwn(body, 'name') ? String(body.name || '').trim() : existing?.name,
    baseUrl: Object.hasOwn(body, 'baseUrl') ? String(body.baseUrl || '').trim() : existing?.base_url,
    providerType: Object.hasOwn(body, 'providerType') ? body.providerType || 'openai_compatible' : existing?.provider_type || 'openai_compatible',
    defaultModel: Object.hasOwn(body, 'defaultModel') ? body.defaultModel || null : existing?.default_model || null,
    isDefault: Object.hasOwn(body, 'isDefault') ? Boolean(body.isDefault) : Boolean(existing?.is_default),
  }
}

async function getVisibleProvider(providerId, userId) {
  return one(
    `SELECT * FROM providers
     WHERE id = $1 AND (user_id = $2 OR user_id IS NULL OR is_global = true)`,
    [providerId, userId],
  )
}

export default async function providerRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const result = await query(
      `SELECT * FROM providers
       WHERE user_id IS NULL OR is_global = true OR user_id = $1
       ORDER BY (user_id IS NULL OR is_global = true) DESC, is_default DESC, created_at ASC`,
      [request.user.id],
    )
    return { providers: result.rows.map(publicProvider) }
  })

  app.post('/', async (request, reply) => {
    const body = request.body || {}
    const name = String(body.name || '').trim()
    const baseUrl = String(body.baseUrl || '').trim()
    if (!name || !baseUrl) return reply.code(400).send({ error: 'Name and base URL are required' })

    const provider = await withTransaction(async (client) => {
      if (body.isDefault) await client.query('UPDATE providers SET is_default = false WHERE user_id = $1', [request.user.id])
      const result = await client.query(
        `INSERT INTO providers (user_id, name, base_url, api_key_ciphertext, provider_type, default_model, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          request.user.id,
          name,
          baseUrl,
          encryptApiKey(String(body.apiKey || '').trim()),
          body.providerType || 'openai_compatible',
          body.defaultModel || null,
          Boolean(body.isDefault),
        ],
      )
      return result.rows[0]
    })
    return reply.code(201).send({ provider: publicProvider(provider) })
  })

  app.patch('/:id', async (request, reply) => {
    const existing = await one('SELECT * FROM providers WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!existing) return reply.code(404).send({ error: 'Provider not found' })
    const body = request.body || {}

    const provider = await withTransaction(async (client) => {
      if (body.isDefault) await client.query('UPDATE providers SET is_default = false WHERE user_id = $1', [request.user.id])
      const apiKeyCiphertext = Object.hasOwn(body, 'apiKey')
        ? encryptApiKey(String(body.apiKey || '').trim())
        : existing.api_key_ciphertext
      const result = await client.query(
        `UPDATE providers
         SET name = COALESCE($3, name),
             base_url = COALESCE($4, base_url),
             api_key_ciphertext = $5,
             provider_type = COALESCE($6, provider_type),
             default_model = $7,
             is_default = COALESCE($8, is_default),
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          request.params.id,
          request.user.id,
          body.name ? String(body.name).trim() : null,
          body.baseUrl ? String(body.baseUrl).trim() : null,
          apiKeyCiphertext,
          body.providerType || null,
          Object.hasOwn(body, 'defaultModel') ? body.defaultModel || null : existing.default_model,
          Object.hasOwn(body, 'isDefault') ? Boolean(body.isDefault) : null,
        ],
      )
      return result.rows[0]
    })
    return { provider: publicProvider(provider) }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query('DELETE FROM providers WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Provider not found' })
    return { ok: true }
  })

  app.get('/:id/models', async (request, reply) => {
    const provider = await getVisibleProvider(request.params.id, request.user.id)
    if (!provider) return reply.code(404).send({ error: 'Provider not found' })
    const models = await loadModels(provider)
    if (!models) return reply.code(502).send({ error: 'Cannot reach backend API' })
    return { models }
  })
}

export async function adminProviderRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const result = await query(
      `SELECT * FROM providers
       WHERE user_id IS NULL OR is_global = true
       ORDER BY created_at ASC`,
    )
    return { providers: result.rows.map(publicProvider) }
  })

  app.post('/', async (request, reply) => {
    const body = request.body || {}
    const input = normalizeProviderInput(body)
    if (!input.name || !input.baseUrl) return reply.code(400).send({ error: 'Name and base URL are required' })

    const result = await query(
      `INSERT INTO providers (user_id, name, base_url, api_key_ciphertext, provider_type, default_model, is_default, is_global)
       VALUES (NULL, $1, $2, $3, $4, $5, false, true)
       RETURNING *`,
      [
        input.name,
        input.baseUrl,
        encryptApiKey(String(body.apiKey || '').trim()),
        input.providerType,
        input.defaultModel,
      ],
    )
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
           default_model = $6,
           is_default = false,
           is_global = true,
           updated_at = now()
       WHERE id = $1 AND (user_id IS NULL OR is_global = true)
       RETURNING *`,
      [request.params.id, input.name, input.baseUrl, apiKeyCiphertext, input.providerType, input.defaultModel],
    )
    return { provider: publicProvider(result.rows[0]) }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query(
      'DELETE FROM providers WHERE id = $1 AND (user_id IS NULL OR is_global = true)',
      [request.params.id],
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'Provider not found' })
    return { ok: true }
  })
}
