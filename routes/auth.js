import bcrypt from 'bcrypt'
import { randomUUID } from 'crypto'
import { one, query, withTransaction } from '../db/index.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
  }
}

async function createToken(app, user) {
  return app.jwt.sign(
    { sub: user.id, email: user.email, jti: randomUUID() },
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  )
}

export default async function authRoutes(app) {
  app.post('/register', async (request, reply) => {
    const email = String(request.body?.email || '').trim().toLowerCase()
    const password = String(request.body?.password || '')
    const displayName = String(request.body?.displayName || '').trim() || null

    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'Valid email is required' })
    if (password.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' })

    try {
      const result = await withTransaction(async (client) => {
        const passwordHash = await bcrypt.hash(password, 12)
        const userRes = await client.query(
          `INSERT INTO users (email, password_hash, display_name)
           VALUES ($1, $2, $3)
           RETURNING id, email, display_name`,
          [email, passwordHash, displayName],
        )
        const user = userRes.rows[0]
        await client.query(
          `INSERT INTO providers (user_id, name, base_url, provider_type, is_default)
           VALUES ($1, $2, $3, $4, true)`,
          [user.id, 'Local Ollama', process.env.DEFAULT_BASE_URL || 'http://localhost:11434', 'ollama'],
        )
        return user
      })
      return { token: await createToken(app, result), user: publicUser(result) }
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'Email is already registered' })
      request.log.error(err)
      return reply.code(500).send({ error: 'Registration failed' })
    }
  })

  app.post('/login', async (request, reply) => {
    const email = String(request.body?.email || '').trim().toLowerCase()
    const password = String(request.body?.password || '')
    const user = await one(
      'SELECT id, email, password_hash, display_name FROM users WHERE email = $1',
      [email],
    )
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    await query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [user.id])
    return { token: await createToken(app, user), user: publicUser(user) }
  })

  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const user = await one('SELECT id, email, display_name FROM users WHERE id = $1', [request.user.id])
    return { user: publicUser(user) }
  })

  app.post('/logout', { preHandler: app.authenticate }, async () => ({ ok: true }))
}
