import bcrypt from 'bcrypt'
import { query } from '../db/index.js'
import { requireAdmin } from '../middleware/auth.js'
import { cacheDelPattern, cacheGetJson, cacheSetJson } from '../db/cache.js'

const DEFAULT_CHAT_SETTINGS = {
  contextMessageLimit: 8,
  contextInputTokenBudget: 4000,
  historyMessageTokenLimit: 800,
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function clampContextMessageLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CHAT_SETTINGS.contextMessageLimit
  return Math.min(Math.max(parsed, 1), 200)
}

function clampContextInputTokenBudget(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CHAT_SETTINGS.contextInputTokenBudget
  return Math.min(Math.max(parsed, 512), 128000)
}

function clampHistoryMessageTokenLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CHAT_SETTINGS.historyMessageTokenLimit
  return Math.min(Math.max(parsed, 64), 8000)
}

function publicAdminUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || '',
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    conversationCount: Number(row.conversation_count || 0),
    messageCount: Number(row.message_count || 0),
  }
}

export default async function adminRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/settings', async () => {
    const cached = await cacheGetJson('app_settings:admin')
    if (cached) return cached
    const result = await query('SELECT key, value FROM app_settings')
    const settings = Object.fromEntries(result.rows.map((row) => [row.key, row.value]))
    const payload = {
      settings: {
        chat: {
          ...DEFAULT_CHAT_SETTINGS,
          ...(settings.chat || {}),
          contextMessageLimit: clampContextMessageLimit(settings.chat?.contextMessageLimit),
          contextInputTokenBudget: clampContextInputTokenBudget(settings.chat?.contextInputTokenBudget),
          historyMessageTokenLimit: clampHistoryMessageTokenLimit(settings.chat?.historyMessageTokenLimit),
        },
      },
    }
    await cacheSetJson('app_settings:admin', payload, 300)
    return payload
  })

  app.put('/settings/chat', async (request) => {
    const value = {
      contextMessageLimit: clampContextMessageLimit(request.body?.contextMessageLimit),
      contextInputTokenBudget: clampContextInputTokenBudget(request.body?.contextInputTokenBudget),
      historyMessageTokenLimit: clampHistoryMessageTokenLimit(request.body?.historyMessageTokenLimit),
    }
    const result = await query(
      `INSERT INTO app_settings (key, value)
       VALUES ('chat', $1)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value`,
      [JSON.stringify(value)],
    )
    await cacheDelPattern('app_settings:*')
    return { setting: result.rows[0] }
  })

  app.get('/dashboard', async () => {
    const [totals, recentUsers, recentConversations, trends, modelStats, topUsers, topConversations] = await Promise.all([
      query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM users WHERE is_admin = true) AS admins,
          (SELECT COUNT(*)::int FROM conversations) AS conversations,
          (SELECT COUNT(*)::int FROM messages) AS messages,
          (SELECT COUNT(*)::int FROM messages WHERE created_at >= now() - interval '24 hours') AS messages_24h,
          (SELECT COUNT(*)::int FROM conversations WHERE created_at >= now() - interval '24 hours') AS conversations_24h,
          (SELECT COALESCE(SUM(token_count), 0)::bigint FROM messages WHERE role = 'assistant') AS total_tokens,
          (SELECT COALESCE(SUM(token_count), 0)::bigint FROM messages WHERE role = 'assistant' AND created_at >= now() - interval '24 hours') AS tokens_24h,
          (SELECT COUNT(DISTINCT user_id)::int FROM messages WHERE created_at >= now() - interval '7 days') AS active_users_7d,
          (SELECT COALESCE(ROUND(AVG(message_count), 1), 0) FROM (
             SELECT COUNT(*)::numeric AS message_count FROM messages GROUP BY conversation_id
           ) t) AS avg_messages_per_conversation,
          (SELECT COALESCE(ROUND(AVG(token_count), 1), 0) FROM messages WHERE role = 'assistant' AND token_count IS NOT NULL) AS avg_tokens_per_assistant_message,
          (SELECT COUNT(DISTINCT model_id)::int FROM messages WHERE role = 'assistant' AND model_id IS NOT NULL AND model_id <> '') AS models_used
      `),
      query(`
        SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, u.last_login_at,
               COUNT(DISTINCT c.id)::int AS conversation_count,
               COUNT(DISTINCT m.id)::int AS message_count
        FROM users u
        LEFT JOIN conversations c ON c.user_id = u.id
        LEFT JOIN messages m ON m.user_id = u.id
        GROUP BY u.id
        ORDER BY COALESCE(u.last_login_at, u.created_at) DESC
        LIMIT 8
      `),
      query(`
        SELECT c.id, c.title, c.created_at, c.updated_at, u.email,
               COUNT(DISTINCT m.id)::int AS message_count
        FROM conversations c
        JOIN users u ON u.id = c.user_id
        LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id, u.email
        ORDER BY c.updated_at DESC
        LIMIT 8
      `),
      query(`
        SELECT
          to_char(day_bucket, 'MM-DD') AS day,
          COALESCE(message_count, 0)::int AS messages,
          COALESCE(conversation_count, 0)::int AS conversations,
          COALESCE(token_total, 0)::bigint AS tokens
        FROM (
          SELECT generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS day_bucket
        ) days
        LEFT JOIN (
          SELECT
            date_trunc('day', m.created_at) AS created_day,
            COUNT(*) FILTER (WHERE m.role IN ('user', 'assistant')) AS message_count,
            COUNT(DISTINCT m.conversation_id) AS conversation_count,
            COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.token_count ELSE 0 END), 0) AS token_total
          FROM messages m
          WHERE m.created_at >= date_trunc('day', now()) - interval '6 days'
          GROUP BY 1
        ) agg ON agg.created_day = days.day_bucket
        ORDER BY day_bucket ASC
      `),
      query(`
        SELECT
          COALESCE(NULLIF(model_id, ''), '未记录模型') AS model_id,
          COUNT(*)::int AS message_count,
          COALESCE(SUM(token_count), 0)::bigint AS total_tokens,
          COALESCE(ROUND(AVG(token_count), 1), 0) AS avg_tokens,
          COUNT(*) FILTER (WHERE error IS NOT NULL AND error <> '')::int AS error_count
        FROM messages
        WHERE role = 'assistant'
        GROUP BY 1
        ORDER BY total_tokens DESC, message_count DESC
        LIMIT 12
      `),
      query(`
        SELECT
          u.id,
          u.email,
          COUNT(DISTINCT c.id)::int AS conversation_count,
          COUNT(m.id)::int AS message_count,
          COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.token_count ELSE 0 END), 0)::bigint AS total_tokens
        FROM users u
        LEFT JOIN conversations c ON c.user_id = u.id
        LEFT JOIN messages m ON m.user_id = u.id
        GROUP BY u.id, u.email
        ORDER BY total_tokens DESC, message_count DESC
        LIMIT 8
      `),
      query(`
        SELECT
          c.id,
          c.title,
          u.email,
          COUNT(m.id)::int AS message_count,
          COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.token_count ELSE 0 END), 0)::bigint AS total_tokens
        FROM conversations c
        JOIN users u ON u.id = c.user_id
        LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id, u.email
        ORDER BY total_tokens DESC, message_count DESC
        LIMIT 8
      `),
    ])

    return {
      totals: totals.rows[0],
      recentUsers: recentUsers.rows.map(publicAdminUser),
      recentConversations: recentConversations.rows.map((row) => ({
        id: row.id,
        title: row.title,
        email: row.email,
        messageCount: Number(row.message_count || 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      trends: trends.rows.map((row) => ({
        day: row.day,
        messages: Number(row.messages || 0),
        conversations: Number(row.conversations || 0),
        tokens: Number(row.tokens || 0),
      })),
      modelStats: modelStats.rows.map((row) => ({
        modelId: row.model_id,
        messageCount: Number(row.message_count || 0),
        totalTokens: Number(row.total_tokens || 0),
        avgTokens: Number(row.avg_tokens || 0),
        errorCount: Number(row.error_count || 0),
      })),
      topUsers: topUsers.rows.map((row) => ({
        id: row.id,
        email: row.email,
        conversationCount: Number(row.conversation_count || 0),
        messageCount: Number(row.message_count || 0),
        totalTokens: Number(row.total_tokens || 0),
      })),
      topConversations: topConversations.rows.map((row) => ({
        id: row.id,
        title: row.title,
        email: row.email,
        messageCount: Number(row.message_count || 0),
        totalTokens: Number(row.total_tokens || 0),
      })),
    }
  })

  app.get('/users', async (request) => {
    const q = String(request.query?.q || '').trim()
    const limit = Math.min(Math.max(Number.parseInt(request.query?.limit, 10) || 50, 1), 100)
    const params = []
    let where = ''
    if (q) {
      params.push(`%${q.toLowerCase()}%`)
      where = `WHERE lower(u.email) LIKE $1 OR lower(COALESCE(u.display_name, '')) LIKE $1`
    }
    params.push(limit)
    const result = await query(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, u.updated_at, u.last_login_at,
              COUNT(DISTINCT c.id)::int AS conversation_count,
              COUNT(DISTINCT m.id)::int AS message_count
       FROM users u
       LEFT JOIN conversations c ON c.user_id = u.id
       LEFT JOIN messages m ON m.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return { users: result.rows.map(publicAdminUser), pagination: { limit } }
  })

  app.post('/users', async (request, reply) => {
    const body = request.body || {}
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const displayName = String(body.displayName || '').trim() || null
    const isAdmin = Boolean(body.isAdmin)

    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: '请输入有效邮箱' })
    if (password.length < 8) return reply.code(400).send({ error: '密码至少需要 8 位' })

    try {
      const passwordHash = await bcrypt.hash(password, 12)
      const result = await query(
        `INSERT INTO users (email, password_hash, display_name, is_admin)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, is_admin, created_at, updated_at, last_login_at,
                   0::int AS conversation_count,
                   0::int AS message_count`,
        [email, passwordHash, displayName, isAdmin],
      )
      return { user: publicAdminUser(result.rows[0]) }
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: '该邮箱已存在' })
      request.log.error(err)
      return reply.code(500).send({ error: '创建用户失败' })
    }
  })

  app.patch('/users/:id', async (request, reply) => {
    const body = request.body || {}
    const targetId = request.params.id
    const existing = await query('SELECT id, is_admin FROM users WHERE id = $1', [targetId])
    if (!existing.rowCount) return reply.code(404).send({ error: 'User not found' })

    let nextEmail = null
    if (Object.hasOwn(body, 'email')) {
      nextEmail = String(body.email || '').trim().toLowerCase()
      if (!EMAIL_RE.test(nextEmail)) return reply.code(400).send({ error: '请输入有效邮箱' })
    }

    let nextPasswordHash = null
    if (Object.hasOwn(body, 'password')) {
      const nextPassword = String(body.password || '')
      if (nextPassword && nextPassword.length < 8) {
        return reply.code(400).send({ error: '密码至少需要 8 位' })
      }
      nextPasswordHash = nextPassword ? await bcrypt.hash(nextPassword, 12) : null
    }

    if (targetId === request.user.id && Object.hasOwn(body, 'isAdmin') && !body.isAdmin) {
      return reply.code(400).send({ error: '不能取消自己的管理员权限' })
    }

    try {
      const result = await query(
        `UPDATE users
         SET email = CASE WHEN $2::boolean THEN $3::text ELSE email END,
             display_name = CASE WHEN $4::boolean THEN $5::text ELSE display_name END,
             password_hash = CASE WHEN $6::boolean AND $7::text IS NOT NULL THEN $7::text ELSE password_hash END,
             is_admin = CASE WHEN $8::boolean THEN $9 ELSE is_admin END,
             updated_at = now()
         WHERE id = $1
         RETURNING id, email, display_name, is_admin, created_at, updated_at, last_login_at,
                   0::int AS conversation_count,
                   0::int AS message_count`,
        [
          targetId,
          Object.hasOwn(body, 'email'),
          nextEmail,
          Object.hasOwn(body, 'displayName'),
          Object.hasOwn(body, 'displayName') ? String(body.displayName || '').trim() || null : null,
          Object.hasOwn(body, 'password'),
          nextPasswordHash,
          Object.hasOwn(body, 'isAdmin'),
          Boolean(body.isAdmin),
        ],
      )
      await cacheDelPattern(`u:${targetId}:*`)
      return { user: publicAdminUser(result.rows[0]) }
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: '该邮箱已存在' })
      request.log.error(err)
      return reply.code(500).send({ error: '更新用户失败' })
    }
  })

  app.delete('/users/:id', async (request, reply) => {
    if (request.params.id === request.user.id) return reply.code(400).send({ error: '不能删除自己' })
    const result = await query('DELETE FROM users WHERE id = $1', [request.params.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'User not found' })
    await cacheDelPattern(`u:${request.params.id}:*`)
    return { ok: true }
  })

  app.get('/conversations/:id', async (request, reply) => {
    const conversationId = request.params.id
    const conversationResult = await query(
      `SELECT c.id, c.title, c.created_at, c.updated_at, u.email,
              COUNT(m.id)::int AS message_count,
              COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.token_count ELSE 0 END), 0)::bigint AS total_tokens
       FROM conversations c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.id = $1
       GROUP BY c.id, u.email`,
      [conversationId],
    )
    if (!conversationResult.rowCount) return reply.code(404).send({ error: 'Conversation not found' })

    const messagesResult = await query(
      `SELECT id, role, content, error, token_count, model_id, finish_reason, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversationId],
    )

    return {
      conversation: {
        id: conversationResult.rows[0].id,
        title: conversationResult.rows[0].title,
        email: conversationResult.rows[0].email,
        messageCount: Number(conversationResult.rows[0].message_count || 0),
        totalTokens: Number(conversationResult.rows[0].total_tokens || 0),
        createdAt: conversationResult.rows[0].created_at,
        updatedAt: conversationResult.rows[0].updated_at,
      },
      messages: messagesResult.rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content || '',
        error: row.error || '',
        tokenCount: Number(row.token_count || 0),
        modelId: row.model_id || '',
        finishReason: row.finish_reason || '',
        createdAt: row.created_at,
      })),
    }
  })
}
