import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { one, query, withTransaction } from '../db/index.js'

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
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    providerType: row.provider_type,
    defaultModel: row.default_model,
    isDefault: row.is_default,
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

export default async function providerRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const result = await query(
      `SELECT * FROM providers WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC`,
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
    const provider = await one('SELECT * FROM providers WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!provider) return reply.code(404).send({ error: 'Provider not found' })
    const models = await loadModels(provider)
    if (!models) return reply.code(502).send({ error: 'Cannot reach backend API' })
    return { models }
  })
}
