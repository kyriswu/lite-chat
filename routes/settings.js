import { query } from '../db/index.js'
import { cacheDel, cacheGetJson, cacheSetJson } from '../db/cache.js'

function settingsCacheKey(userId) {
  return `u:${userId}:settings`
}

export default async function settingsRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const cacheKey = settingsCacheKey(request.user.id)
    const cached = await cacheGetJson(cacheKey)
    if (cached) return cached

    const result = await query('SELECT key, value FROM settings WHERE user_id = $1', [request.user.id])
    const payload = { settings: Object.fromEntries(result.rows.map((row) => [row.key, row.value])) }
    await cacheSetJson(cacheKey, payload, 300)
    return payload
  })

  app.put('/:key', async (request) => {
    const value = request.body?.value ?? {}
    const result = await query(
      `INSERT INTO settings (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value`,
      [request.user.id, request.params.key, JSON.stringify(value)],
    )
    await cacheDel(settingsCacheKey(request.user.id))
    return { setting: result.rows[0] }
  })

  app.delete('/:key', async (request) => {
    await query('DELETE FROM settings WHERE user_id = $1 AND key = $2', [request.user.id, request.params.key])
    await cacheDel(settingsCacheKey(request.user.id))
    return { ok: true }
  })
}
