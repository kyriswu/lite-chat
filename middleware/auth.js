import { one } from '../db/index.js'

export async function authenticate(request, reply) {
  try {
    const payload = await request.jwtVerify()
    const user = await one('SELECT id, email, is_admin FROM users WHERE id = $1', [payload.sub])
    if (!user) throw new Error('User not found')
    request.user = {
      id: user.id,
      email: user.email,
      isAdmin: user.is_admin,
    }
  } catch {
    return reply.code(401).send({ error: 'Authentication required' })
  }
}

export async function requireAdmin(request, reply) {
  if (!request.user?.isAdmin) {
    return reply.code(403).send({ error: 'Admin permission required' })
  }
}
