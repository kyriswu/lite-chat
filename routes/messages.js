import { one, query, withTransaction } from '../db/index.js'
import { cacheDelPattern, cacheGetJson, cacheSetJson } from '../db/cache.js'
import { chatCompletionsUrl, decryptApiKey, responsesUrl } from './providers.js'

const DEFAULT_CONTEXT_MESSAGE_LIMIT = 20

function normalizeContent(content) {
  if (Array.isArray(content) || typeof content === 'string') return content
  if (content && typeof content === 'object') return content
  return String(content || '')
}

function estimateTokenCount(text = '') {
  const normalized = String(text || '')
  if (!normalized) return 0
  return Math.max(1, Math.ceil(normalized.length / 4))
}

function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTokenCount(content)
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part?.type === 'text') return sum + estimateTokenCount(part.text || '')
      if (part?.type === 'image_url') return sum + 85
      return sum
    }, 0)
  }
  return estimateTokenCount(JSON.stringify(content || ''))
}

function hasRenderableContent(content) {
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part?.type === 'text') return String(part.text || '').trim().length > 0
      if (part?.type === 'image_url') return Boolean(part.image_url?.url)
      return false
    })
  }
  return content && Object.keys(content).length > 0
}

function buildUpstreamMessages(rows, systemPrompt, fallbackUserContent = null) {
  const upstreamMessages = []
  if (systemPrompt) upstreamMessages.push({ role: 'system', content: systemPrompt })
  for (const row of rows) {
    if (!['system', 'user', 'assistant'].includes(row.role)) continue
    if (!hasRenderableContent(row.content)) continue
    upstreamMessages.push({ role: row.role, content: row.content })
  }
  const hasChatMessage = upstreamMessages.some((message) => ['user', 'assistant'].includes(message.role))
  if (!hasChatMessage && hasRenderableContent(fallbackUserContent)) {
    upstreamMessages.push({ role: 'user', content: fallbackUserContent })
  }
  return upstreamMessages
}

function getRequestBaseUrl(request) {
  const forwardedProto = request.headers['x-forwarded-proto']
  const protocol = String(
    Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || request.protocol || 'http',
  ).split(',')[0].trim() || 'http'
  const host = request.headers['x-forwarded-host'] || request.headers.host
  if (!host) return null
  return `${protocol}://${host}`
}

function inferMimeTypeFromUrl(url) {
  const value = String(url || '').toLowerCase()
  if (value.endsWith('.png')) return 'image/png'
  if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg'
  if (value.endsWith('.gif')) return 'image/gif'
  if (value.endsWith('.webp')) return 'image/webp'
  if (value.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

function normalizeFetchedMimeType(contentType, sourceUrl) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (normalized.startsWith('image/')) return normalized
  const inferred = inferMimeTypeFromUrl(sourceUrl)
  return inferred.startsWith('image/') ? inferred : 'image/png'
}

function buildDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`
}

async function normalizeImageUrlForUpstream(url, request) {
  const rawUrl = String(url || '').trim()
  if (!rawUrl) return null
  if (rawUrl.startsWith('data:')) {
    const mediaTypeMatch = rawUrl.match(/^data:([^;,]+)[;,]/i)
    return {
      url: rawUrl,
      mediaType: mediaTypeMatch?.[1] || 'image/png',
    }
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    const response = await fetch(rawUrl, {
      headers: { 'user-agent': 'Lite Chat Image Fetcher' },
    })
    if (!response.ok) {
      throw new Error(`图片抓取失败: ${response.status}`)
    }
    const contentType = normalizeFetchedMimeType(response.headers.get('content-type'), rawUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      url: buildDataUrl(buffer, contentType),
      mediaType: contentType,
    }
  }

  const baseUrl = getRequestBaseUrl(request)
  if (baseUrl) {
    try {
      const resolvedUrl = new URL(rawUrl, baseUrl).toString()
      const response = await fetch(resolvedUrl, {
        headers: { 'user-agent': 'Lite Chat Image Fetcher' },
      })
      if (!response.ok) {
        throw new Error(`图片抓取失败: ${response.status}`)
      }
      const contentType = normalizeFetchedMimeType(response.headers.get('content-type'), resolvedUrl)
      const buffer = Buffer.from(await response.arrayBuffer())
      return {
        url: buildDataUrl(buffer, contentType),
        mediaType: contentType,
      }
    } catch {}
  }
  return null
}

async function normalizeContentForUpstream(content, request) {
  if (!Array.isArray(content)) return content
  const normalized = []
  for (const part of content) {
    if (part?.type !== 'image_url') {
      normalized.push(part)
      continue
    }
    const imageUrl = await normalizeImageUrlForUpstream(part.image_url?.url, request)
    if (!imageUrl?.url) continue
    normalized.push({
      type: 'image_url',
      _litechat_media_type: imageUrl.mediaType,
      image_url: {
        url: imageUrl.url,
      },
    })
  }
  return normalized
}

function toResponsesContentPart(part) {
  if (part?.type === 'image_url' && part.image_url?.url) {
    return {
      type: 'input_image',
      image_url: String(part.image_url.url),
    }
  }
  return {
    type: 'input_text',
    text: String(part?.text || ''),
  }
}

function toResponsesMessage(message) {
  const content = Array.isArray(message.content)
    ? message.content.map(toResponsesContentPart).filter((part) => (
      part.type === 'input_image' ? Boolean(part.image_url) : Boolean(part.text)
    ))
    : [{ type: 'input_text', text: String(message.content || '') }].filter((part) => Boolean(part.text))
  return { role: message.role, content }
}

function buildResponsesPayload({ model, systemPrompt, upstreamMessages }) {
  const payload = {
    model,
    input: upstreamMessages
      .filter((message) => message.role !== 'system')
      .map(toResponsesMessage)
      .filter((message) => message.content.length > 0),
    stream: true,
  }
  if (systemPrompt) payload.instructions = systemPrompt
  return payload
}

function parseResponsesUsage(usage) {
  if (!usage) return null
  return {
    promptTokens: Number(usage.input_tokens ?? usage.prompt_tokens) || 0,
    completionTokens: Number(usage.output_tokens ?? usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
  }
}

function extractResponsesOutputText(output) {
  if (!Array.isArray(output)) return ''
  return output.flatMap((item) => (
    Array.isArray(item?.content)
      ? item.content.map((part) => String(part?.text || part?.output_text || ''))
      : []
  )).join('')
}

function parseResponsesSse(buffer) {
  const events = []
  let rest = buffer
  while (true) {
    const boundary = rest.indexOf('\n\n')
    if (boundary < 0) break
    const rawEvent = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const dataLines = []
    let eventName = ''
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    events.push({ eventName, data: dataLines.join('\n') })
  }
  return { events, rest }
}

function clampContextMessageLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_MESSAGE_LIMIT
  return Math.min(Math.max(parsed, 1), 200)
}

async function getChatContextMessageLimit() {
  const cached = await cacheGetJson('app_settings:chat_context_limit')
  if (cached?.limit) return clampContextMessageLimit(cached.limit)
  const row = await one("SELECT value FROM app_settings WHERE key = 'chat'")
  const limit = clampContextMessageLimit(row?.value?.contextMessageLimit)
  await cacheSetJson('app_settings:chat_context_limit', { limit }, 300)
  return limit
}

async function getRecentConversationMessages(conversationId, userId, limit) {
  const result = await query(
    `SELECT role, content
     FROM (
       SELECT role, content, created_at
       FROM messages
       WHERE conversation_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT $3
     ) recent
     ORDER BY created_at ASC`,
    [conversationId, userId, clampContextMessageLimit(limit)],
  )
  return result.rows
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
    error: row.error,
  }
}

async function ensureConversation(id, userId, reply) {
  // 支持 "new" 或空值时自动创建新对话
  if (!id || id === 'new') {
    const result = await one(
      `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *`,
      [userId, '新对话'],
    )
    return result
  }
  const conversation = await one('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, userId])
  if (!conversation) {
    reply.code(404).send({ error: 'Conversation not found' })
    return null
  }
  return conversation
}

async function resolveChatContext({ body, conversation, userId, reply }) {
  const providerId = body.providerId || conversation.provider_id
  let provider = null
  if (providerId) {
    provider = await one(
      `SELECT * FROM providers
       WHERE id = $1 AND (user_id = $2 OR user_id IS NULL OR is_global = true)`,
      [providerId, userId],
    )
  }
  if (!provider) {
    provider = await one(
      `SELECT *
       FROM providers
       WHERE is_global = true OR user_id IS NULL
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1`,
    )
  }
  if (!provider) {
    reply.code(400).send({ error: 'Provider is required: no global provider configured' })
    return null
  }

  const model = body.model || provider.default_model || conversation.model
  if (!model) {
    reply.code(400).send({ error: 'Model is required: configure a default model for the global provider' })
    return null
  }

  let systemPrompt = conversation.system_prompt
  if (body.skillId) {
    const skill = await one('SELECT system_prompt FROM skills WHERE id = $1 AND is_active = true', [body.skillId])
    if (skill?.system_prompt) systemPrompt = skill.system_prompt
  }

  const headers = { 'Content-Type': 'application/json' }
  const apiKey = decryptApiKey(provider.api_key_ciphertext)
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  return {
    provider,
    model,
    systemPrompt,
    headers,
    apiFormat: provider.api_format || 'openai_chat_completions',
  }
}

async function streamChatCompletion({ request, reply, provider, model, headers, upstreamMessages }) {
  const abortController = new AbortController()
  const abortUpstream = () => abortController.abort()
  request.raw.on('close', abortUpstream)
  reply.raw.on('close', abortUpstream)
  let upstreamRes
  try {
    upstreamRes = await fetch(chatCompletionsUrl(provider.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: upstreamMessages,
        stream: true,
      }),
      signal: abortController.signal,
    })
  } catch (err) {
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
    return { handled: false, errorStatus: 502, errorPayload: { error: `Network error: ${err.message}` } }
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text()
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
    return { handled: false, errorStatus: upstreamRes.status, errorPayload: { error: text } }
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
  let responseModel = model
  let usage = null

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
          if (chunk?.model) responseModel = chunk.model
          if (chunk?.usage) {
            usage = {
              promptTokens: Number(chunk.usage.prompt_tokens) || 0,
              completionTokens: Number(chunk.usage.completion_tokens) || 0,
              totalTokens: Number(chunk.usage.total_tokens) || 0,
            }
          }
          assistantContent += chunk.choices?.[0]?.delta?.content || ''
        } catch {}
      }
    }
  } catch (err) {
    streamError = abortController.signal.aborted ? 'Generation stopped' : err.message
  } finally {
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
  }

  return { handled: true, assistantContent, streamError, responseModel, usage }
}

async function streamResponses({ request, reply, provider, model, headers, upstreamMessages }) {
  const abortController = new AbortController()
  const abortUpstream = () => abortController.abort()
  request.raw.on('close', abortUpstream)
  reply.raw.on('close', abortUpstream)
  let upstreamRes
  try {
    upstreamRes = await fetch(responsesUrl(provider.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify(buildResponsesPayload({
        model,
        systemPrompt: upstreamMessages.find((message) => message.role === 'system')?.content || '',
        upstreamMessages,
      })),
      signal: abortController.signal,
    })
  } catch (err) {
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
    return { handled: false, errorStatus: 502, errorPayload: { error: `Network error: ${err.message}` } }
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text()
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
    return { handled: false, errorStatus: upstreamRes.status, errorPayload: { error: text } }
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
  let responseModel = model
  let usage = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseResponsesSse(buffer)
      buffer = parsed.rest
      for (const event of parsed.events) {
        if (!event.data || event.data === '[DONE]') continue
        try {
          const payload = JSON.parse(event.data)
          const type = event.eventName || payload?.type || ''
          const nextUsage = parseResponsesUsage(payload?.usage || payload?.response?.usage)
          if (nextUsage) usage = nextUsage
          if (payload?.response?.model || payload?.model) responseModel = payload.response?.model || payload.model
          if (type === 'response.output_text.delta' && payload?.delta) {
            const delta = String(payload.delta)
            assistantContent += delta
            reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
          } else if (type === 'response.completed' && !assistantContent) {
            const completedText = extractResponsesOutputText(payload?.response?.output)
            if (completedText) {
              assistantContent = completedText
              reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: completedText } }] })}\n\n`)
            }
          }
        } catch {}
      }
    }
    reply.raw.write('data: [DONE]\n\n')
  } catch (err) {
    streamError = abortController.signal.aborted ? 'Generation stopped' : err.message
  } finally {
    request.raw.off('close', abortUpstream)
    reply.raw.off('close', abortUpstream)
  }

  return { handled: true, assistantContent, streamError, responseModel, usage }
}

async function streamProviderChat({ request, reply, context, upstreamMessages }) {
  if (context.apiFormat === 'openai_responses') {
    return streamResponses({
      request,
      reply,
      provider: context.provider,
      model: context.model,
      headers: context.headers,
      upstreamMessages,
    })
  }
  return streamChatCompletion({
    request,
    reply,
    provider: context.provider,
    model: context.model,
    headers: context.headers,
    upstreamMessages,
  })
}

async function clearConversationCaches(userId, conversationId) {
  await cacheDelPattern(`u:${userId}:conversations:*`)
  await cacheDelPattern(`u:${userId}:conversation:${conversationId}:*`)
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
    await cacheDelPattern(`u:${request.user.id}:conversations:*`)
    await cacheDelPattern(`u:${request.user.id}:conversation:${conversation.id}:*`)
    return reply.code(201).send({ message: publicMessage(result.rows[0]) })
  })

  app.delete('/messages/:id', async (request, reply) => {
    const result = await query('DELETE FROM messages WHERE id = $1 AND user_id = $2 RETURNING conversation_id', [request.params.id, request.user.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Message not found' })
    await clearConversationCaches(request.user.id, result.rows[0].conversation_id)
    return { ok: true }
  })

  app.post('/messages/:id/regenerate', async (request, reply) => {
    const body = request.body || {}
    const existing = await one(
      `SELECT m.*, c.title, c.provider_id, c.model, c.system_prompt
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
       WHERE m.id = $1 AND m.user_id = $2 AND m.role = 'user'`,
      [request.params.id, request.user.id],
    )
    if (!existing) return reply.code(404).send({ error: 'User message not found' })

    const conversation = {
      id: existing.conversation_id,
      title: existing.title,
      provider_id: existing.provider_id,
      model: existing.model,
      system_prompt: existing.system_prompt,
    }
    const context = await resolveChatContext({ body, conversation, userId: request.user.id, reply })
    if (!context) return

    const userContent = normalizeContent(body.message?.content ?? body.content)
    const userText = Array.isArray(userContent)
      ? userContent.find((part) => part.type === 'text')?.text || '图片消息'
      : String(userContent || '')

    await withTransaction(async (client) => {
      const ordered = await client.query(
        `SELECT id
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2
         ORDER BY created_at ASC, id ASC`,
        [conversation.id, request.user.id],
      )
      const currentIndex = ordered.rows.findIndex((row) => row.id === existing.id)
      const deleteIds = currentIndex >= 0
        ? ordered.rows.slice(currentIndex + 1).map((row) => row.id)
        : []
      if (deleteIds.length) {
        await client.query(
          'DELETE FROM messages WHERE user_id = $1 AND id = ANY($2::uuid[])',
          [request.user.id, deleteIds],
        )
      }
      await client.query(
        `UPDATE messages
         SET content = $3, error = NULL
         WHERE id = $1 AND user_id = $2`,
        [existing.id, request.user.id, JSON.stringify(userContent)],
      )
    })
    await clearConversationCaches(request.user.id, conversation.id)

    const contextMessageLimit = await getChatContextMessageLimit()
    const rows = await getRecentConversationMessages(conversation.id, request.user.id, contextMessageLimit)
    const upstreamMessages = await Promise.all(
      buildUpstreamMessages(rows, context.systemPrompt, userContent)
        .map(async (message) => ({ ...message, content: await normalizeContentForUpstream(message.content, request) })),
    )

    const streamResult = await streamProviderChat({ request, reply, context, upstreamMessages })
    if (!streamResult.handled) return reply.code(streamResult.errorStatus).send(streamResult.errorPayload)

    if (streamResult.assistantContent) {
      const promptTokens = streamResult.usage?.promptTokens || upstreamMessages.reduce((sum, message) => sum + estimateContentTokens(message.content), 0)
      const completionTokens = streamResult.usage?.completionTokens || estimateContentTokens(streamResult.assistantContent)
      const totalTokens = streamResult.usage?.totalTokens || (promptTokens + completionTokens)
      await query(
        `INSERT INTO messages (conversation_id, user_id, role, content, token_count, prompt_tokens, completion_tokens, model_id, error)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
        [
          conversation.id,
          request.user.id,
          JSON.stringify(streamResult.assistantContent),
          totalTokens,
          promptTokens,
          completionTokens,
          streamResult.responseModel || context.model,
          streamResult.streamError,
        ],
      )
    }

    const nextTitle = conversation.title === '新对话' && userText ? userText.slice(0, 28) : conversation.title
    await query(
      `UPDATE conversations
       SET title = $3, provider_id = $4, model = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [conversation.id, request.user.id, nextTitle, context.provider.id, context.model],
    )
    await clearConversationCaches(request.user.id, conversation.id)
    reply.raw.end()
  })

  app.post('/chat', async (request, reply) => {
    const body = request.body || {}
    const conversation = await ensureConversation(body.conversationId, request.user.id, reply)
    if (!conversation) return

    const context = await resolveChatContext({ body, conversation, userId: request.user.id, reply })
    if (!context) return

    const userContent = normalizeContent(body.message?.content ?? body.content)
    const userText = Array.isArray(userContent)
      ? userContent.find((part) => part.type === 'text')?.text || '图片消息'
      : String(userContent || '')

    await query(
      `INSERT INTO messages (conversation_id, user_id, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [conversation.id, request.user.id, JSON.stringify(userContent)],
    )
    await clearConversationCaches(request.user.id, conversation.id)

    const contextMessageLimit = await getChatContextMessageLimit()
    const rows = await getRecentConversationMessages(conversation.id, request.user.id, contextMessageLimit)
    const upstreamMessages = await Promise.all(
      buildUpstreamMessages(rows, context.systemPrompt, userContent)
        .map(async (message) => ({ ...message, content: await normalizeContentForUpstream(message.content, request) })),
    )

    const streamResult = await streamProviderChat({ request, reply, context, upstreamMessages })
    if (!streamResult.handled) return reply.code(streamResult.errorStatus).send(streamResult.errorPayload)

    if (streamResult.assistantContent) {
      const promptTokens = streamResult.usage?.promptTokens || upstreamMessages.reduce((sum, message) => sum + estimateContentTokens(message.content), 0)
      const completionTokens = streamResult.usage?.completionTokens || estimateContentTokens(streamResult.assistantContent)
      const totalTokens = streamResult.usage?.totalTokens || (promptTokens + completionTokens)
      await query(
        `INSERT INTO messages (conversation_id, user_id, role, content, token_count, prompt_tokens, completion_tokens, model_id, error)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
        [
          conversation.id,
          request.user.id,
          JSON.stringify(streamResult.assistantContent),
          totalTokens,
          promptTokens,
          completionTokens,
          streamResult.responseModel || context.model,
          streamResult.streamError,
        ],
      )
    }

    const nextTitle = conversation.title === '新对话' && userText ? userText.slice(0, 28) : conversation.title
    await query(
      `UPDATE conversations
       SET title = $3, provider_id = $4, model = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [conversation.id, request.user.id, nextTitle, context.provider.id, context.model],
    )
    await clearConversationCaches(request.user.id, conversation.id)
    reply.raw.end()
  })
}
