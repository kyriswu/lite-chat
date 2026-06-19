import { query } from '../db/index.js'

export default async function settingsRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async (request) => {
    const result = await query('SELECT key, value FROM settings WHERE user_id = $1 ORDER BY key ASC', [request.user.id])
    return { settings: Object.fromEntries(result.rows.map((row) => [row.key, row.value])) }
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
    return { setting: result.rows[0] }
  })

  app.delete('/:key', async (request) => {
    await query('DELETE FROM settings WHERE user_id = $1 AND key = $2', [request.user.id, request.params.key])
    return { ok: true }
  })
}
