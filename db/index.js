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

export async function runMigrations() {
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false')
  await query('ALTER TABLE providers ALTER COLUMN user_id DROP NOT NULL')
  await query('ALTER TABLE providers ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT false')
  await query('UPDATE providers SET is_global = true WHERE user_id IS NULL')
  await query('CREATE UNIQUE INDEX IF NOT EXISTS providers_global_name_idx ON providers(name) WHERE is_global = true')
  await query(`
    CREATE TABLE IF NOT EXISTS skills (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      system_prompt TEXT NOT NULL,
      icon TEXT DEFAULT '🤖',
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query('CREATE INDEX IF NOT EXISTS skills_sort_idx ON skills(sort_order ASC, created_at ASC)')
  await query(`
    CREATE TABLE IF NOT EXISTS skill_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      storage_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query('CREATE INDEX IF NOT EXISTS skill_files_skill_id_idx ON skill_files(skill_id)')
  await query('ALTER TABLE skills ADD COLUMN IF NOT EXISTS clawhub_slug TEXT')
  await query('ALTER TABLE skills ADD COLUMN IF NOT EXISTS clawhub_version TEXT')
  await query('ALTER TABLE skills ADD COLUMN IF NOT EXISTS clawhub_imported_at TIMESTAMPTZ')
}

export async function closePool() {
  await pool.end()
}
