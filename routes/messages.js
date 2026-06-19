import { one, query } from '../db/index.js'
import { decryptApiKey } from './providers.js'

function normalizeContent(content) {
  if (Array.isArray(content) || typeof content === 'string') return content
  if (content && typeof content === 'object') return content
  return String(content || '')
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

async function ensureConversation(id, userId, reply) {
  const conversation = await one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, userId])
  if (!conversation) {
    reply.code(404).send({ error: 'Conversation not found' })
    return null
  }
  return conversation
}

export default async function messageRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/messages/conversation/:conversationId', async (request, reply) => {
    const conversation = await ensureConversation(request.params.conversationId, request.user.id, reply)
    if (!conversation) return
    const result = await query(
      'SELECT * FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
      [conversation.id, request.user.id],
    )
    return { messages: result.rows.map(publicMessage) }
  })

  app.post('/messages/conversation/:conversationId', async (request, reply) => {
    const conversation = await ensureConversation(request.params.conversationId, request.user.id, reply)
    if (!conversation) return
    const role = request.body?.role
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) return reply.code(400).send({ error: 'Invalid role' })
    const result = await query(
      `INSERT INTO messages (conversation_id, user_id, role, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [conversation.id, request.user.id, role, JSON.stringify(normalizeContent(request.body?.content))],
    )
    await query('UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2', [conversation.id, request.user.id])
    return reply.code(201).send({ message: publicMessage(result.rows[0]) })
  })

  app.delete('/messages/:id', async (request, reply) => {
    const result = await query('DELETE FROM messages WHERE id = $1 AND user_id = $2', [request.params.id, request.user.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Message not found' })
    return { ok: true }
  })

  app.post('/chat', async (request, reply) => {
    const body = request.body || {}
    const conversation = await ensureConversation(body.conversationId, request.user.id, reply)
    if (!conversation) return

    const providerId = body.providerId || conversation.provider_id
    const provider = await one('SELECT * FROM providers WHERE id = $1 AND user_id = $2', [providerId, request.user.id])
    if (!provider) return reply.code(400).send({ error: 'Provider is required' })

    const model = body.model || conversation.model || provider.default_model
    if (!model) return reply.code(400).send({ error: 'Model is required' })

    const userContent = normalizeContent(body.message?.content ?? body.content)
    const userText = Array.isArray(userContent)
      ? userContent.find((part) => part.type === 'text')?.text || '图片消息'
      : String(userContent || '')

    await query(
      `INSERT INTO messages (conversation_id, user_id, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [conversation.id, request.user.id, JSON.stringify(userContent)],
    )

    const rows = await query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
      [conversation.id, request.user.id],
    )
    const upstreamMessages = []
    if (conversation.system_prompt) upstreamMessages.push({ role: 'system', content: conversation.system_prompt })
    for (const row of rows.rows) upstreamMessages.push({ role: row.role, content: row.content })

    const headers = { 'Content-Type': 'application/json' }
    const apiKey = decryptApiKey(provider.api_key_ciphertext)
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let upstreamRes
    try {
      upstreamRes = await fetch(`${provider.base_url.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: upstreamMessages, stream: body.stream !== false }),
      })
    } catch (err) {
      return reply.code(502).send({ error: `Network error: ${err.message}` })
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      return reply.code(upstreamRes.status).send({ error: text })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    })

    const reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assistantContent = ''
    let streamError = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunkText = decoder.decode(value, { stream: true })
        reply.raw.write(chunkText)

        buffer += chunkText
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload)
            assistantContent += chunk.choices?.[0]?.delta?.content || ''
          } catch {}
        }
      }
    } catch (err) {
      streamError = err.message
    } finally {
      reply.raw.end()
    }

    if (assistantContent) {
      await query(
        `INSERT INTO messages (conversation_id, user_id, role, content, error)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [conversation.id, request.user.id, JSON.stringify(assistantContent), streamError],
      )
    }

    const nextTitle = conversation.title === '新对话' && userText ? userText.slice(0, 28) : conversation.title
    await query(
      `UPDATE conversations
       SET title = $3, provider_id = $4, model = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [conversation.id, request.user.id, nextTitle, provider.id, model],
    )
  })
}
