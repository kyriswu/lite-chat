import { one, query } from '../db/index.js'

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
    error: row.error,
  }
}

export default async function conversationRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const result = await query(
      `SELECT * FROM conversations
       WHERE user_id = $1 AND archived_at IS NULL
       ORDER BY updated_at DESC`,
      [request.user.id],
    )
    return { conversations: result.rows.map(publicConversation) }
  })

  app.post('/', async (request, reply) => {
    const body = request.body || {}
    const title = String(body.title || '新对话').trim() || '新对话'
    const providerId = body.providerId || null
    if (providerId) {
      const provider = await one('SELECT id FROM providers WHERE id = $1 AND user_id = $2', [providerId, request.user.id])
      if (!provider) return reply.code(400).send({ error: 'Provider not found' })
    }
    const result = await query(
      `INSERT INTO conversations (user_id, provider_id, title, system_prompt, model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [request.user.id, providerId, title, body.systemPrompt || null, body.model || null],
    )
    return reply.code(201).send({ conversation: publicConversation(result.rows[0]) })
  })

  app.get('/:id', async (request, reply) => {
    const conversation = await one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' })
    const messages = await query(
      'SELECT * FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
      [request.params.id, request.user.id],
    )
    return { conversation: publicConversation(conversation), messages: messages.rows.map(publicMessage) }
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
    return { conversation: publicConversation(result.rows[0]) }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Conversation not found' })
    return { ok: true }
  })
}
