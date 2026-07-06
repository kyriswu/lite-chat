import { one, query } from '../db/index.js'
import { cacheGetJson, cacheGetNumber, cacheIncr, cacheSetJson } from '../db/cache.js'

function publicConversation(row) {
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    systemPrompt: row.system_prompt || '',
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function publicMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    tokenCount: row.token_count,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    modelId: row.model_id,
    finishReason: row.finish_reason,
    error: row.error,
  }
}

function parsePositiveInt(value, fallback, max = 500) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

async function getConversationCacheVersion(userId) {
  return cacheGetNumber(`u:${userId}:conversations:version`, 0)
}

async function bumpConversationCacheVersion(userId) {
  await cacheIncr(`u:${userId}:conversations:version`, 86400)
}

export default async function conversationRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const limit = parsePositiveInt(request.query?.limit, null, 200)
    const version = await getConversationCacheVersion(request.user.id)
    const cacheKey = `u:${request.user.id}:conversations:v:${version}:limit:${limit || 'all'}`
    const cached = await cacheGetJson(cacheKey)
    if (cached) return cached
    const result = await query(
      `SELECT *
       FROM conversations
       WHERE user_id = $1 AND archived_at IS NULL
       ORDER BY updated_at DESC
       ${limit ? 'LIMIT $2' : ''}`,
      limit ? [request.user.id, limit] : [request.user.id],
    )
    const payload = { conversations: result.rows.map(publicConversation), pagination: limit ? { limit } : null }
    await cacheSetJson(cacheKey, payload, 15)
    return payload
  })

  app.post('/', async (request, reply) => {
    const body = request.body || {}
    const title = String(body.title || '新对话').trim() || '新对话'
    const providerId = body.providerId || null
    if (providerId) {
      const provider = await one('SELECT id FROM providers WHERE id = $1 AND user_id = $2', [providerId, request.user.id])
      if (!provider) return reply.code(400).send({ error: 'Provider not found' })
    }

    // Prevent unlimited empty draft conversations: if the newest conversation is
    // still an untouched default "新对话", reuse it instead of creating another one.
    const latest = await one(
      `SELECT c.*,
              EXISTS (
                SELECT 1 FROM messages m WHERE m.conversation_id = c.id
              ) AS has_messages
       FROM conversations c
       WHERE c.user_id = $1 AND c.archived_at IS NULL
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [request.user.id],
    )

    if (latest && !latest.has_messages && latest.title === '新对话') {
      return { conversation: publicConversation(latest), reused: true }
    }

    const result = await query(
      `INSERT INTO conversations (user_id, provider_id, title, system_prompt, model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [request.user.id, providerId, title, body.systemPrompt || null, body.model || null],
    )
    await bumpConversationCacheVersion(request.user.id)
    return reply.code(201).send({ conversation: publicConversation(result.rows[0]) })
  })

  app.get('/:id', async (request, reply) => {
    const limit = parsePositiveInt(request.query?.limit, null)
    const before = String(request.query?.before || '').trim()
    const version = await getConversationCacheVersion(request.user.id)
    const cacheKey = `u:${request.user.id}:conversation:${request.params.id}:v:${version}:limit:${limit || 'all'}:before:${before || 'latest'}`
    const cached = await cacheGetJson(cacheKey)
    if (cached) return cached

    const conversationQuery = one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    let messages
    let messagesQuery
    if (limit) {
      const params = [request.params.id, request.user.id, limit + 1]
      const beforeClause = before ? 'AND created_at < $4' : ''
      if (before) params.push(before)
      messagesQuery = query(
        `SELECT *
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2 ${beforeClause}
         ORDER BY created_at DESC
         LIMIT $3`,
        params,
      )
    } else {
      messagesQuery = query(
        'SELECT * FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
        [request.params.id, request.user.id],
      )
    }
    const [conversation, messagesResult] = await Promise.all([conversationQuery, messagesQuery])
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })

    messages = messagesResult
    let hasMore = false
    if (limit) {
      hasMore = messages.rows.length > limit
      if (hasMore) messages.rows.pop()
      messages.rows.reverse()
    }
    const payload = {
      conversation: publicConversation(conversation),
      messages: messages.rows.map(publicMessage),
      pagination: limit ? {
        limit,
        hasMore,
        before: messages.rows[0]?.created_at || null,
      } : null,
    }
    await cacheSetJson(cacheKey, payload, limit ? 30 : 10)
    return payload
  })

  app.patch('/:id', async (request, reply) => {
    const existing = await one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!existing) return reply.code(404).send({ error: 'Conversation not found' })
    const body = request.body || {}
    if (body.providerId) {
      const provider = await one('SELECT id FROM providers WHERE id = $1 AND user_id = $2', [body.providerId, request.user.id])
      if (!provider) return reply.code(400).send({ error: 'Provider not found' })
    }
    const result = await query(
      `UPDATE conversations
       SET title = COALESCE($3, title),
           system_prompt = $4,
           provider_id = $5,
           model = $6,
           archived_at = $7,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        request.params.id,
        request.user.id,
        body.title ? String(body.title).trim() : null,
        Object.hasOwn(body, 'systemPrompt') ? body.systemPrompt || null : existing.system_prompt,
        Object.hasOwn(body, 'providerId') ? body.providerId || null : existing.provider_id,
        Object.hasOwn(body, 'model') ? body.model || null : existing.model,
        body.archived ? new Date() : existing.archived_at,
      ],
    )
    await bumpConversationCacheVersion(request.user.id)
    return { conversation: publicConversation(result.rows[0]) }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Conversation not found' })
    await bumpConversationCacheVersion(request.user.id)
    return { ok: true }
  })
}
