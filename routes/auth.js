import bcrypt from 'bcrypt'
import { randomUUID } from 'crypto'
import { one, query } from '../db/index.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
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
      const passwordHash = await bcrypt.hash(password, 12)
      const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
      const isAdmin = Boolean(adminEmail && email === adminEmail)
      const result = await one(
        `INSERT INTO users (email, password_hash, display_name, is_admin)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, is_admin`,
        [email, passwordHash, displayName, isAdmin],
      )
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
      'SELECT id, email, password_hash, display_name, is_admin FROM users WHERE email = $1',
      [email],
    )
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
    const shouldBeAdmin = Boolean(adminEmail && user.email === adminEmail)
    if (shouldBeAdmin && !user.is_admin) user.is_admin = true
    await query(
      'UPDATE users SET is_admin = is_admin OR $2, last_login_at = now(), updated_at = now() WHERE id = $1',
      [user.id, shouldBeAdmin],
    )
    return { token: await createToken(app, user), user: publicUser(user) }
  })

  app.get('/me', { preHandler: app.authenticate }, async (request) => {
    const user = await one('SELECT id, email, display_name, is_admin FROM users WHERE id = $1', [request.user.id])
    return { user: publicUser(user) }
  })

  app.post('/logout', { preHandler: app.authenticate }, async () => ({ ok: true }))
}
