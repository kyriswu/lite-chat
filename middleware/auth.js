export async function authenticate(request, reply) {
  try {
    const payload = await request.jwtVerify()
    request.user = {
      id: payload.sub,
      email: payload.email,
    }
  } catch {
    return reply.code(401).send({ error: 'Authentication required' })
  }
}
