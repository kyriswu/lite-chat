import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://lite_chat:lite_chat_dev_password@localhost:5432/lite_chat',
})

export function query(text, params = []) {
  return pool.query(text, params)
}

export async function one(text, params = []) {
  const result = await query(text, params)
  return result.rows[0] || null
}

export async function withTransaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function closePool() {
  await pool.end()
}
