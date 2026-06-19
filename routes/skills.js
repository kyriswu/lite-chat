import { exec } from 'child_process'
import { one, query } from '../db/index.js'

const CLAWHUB_WORKSPACE = '/root/.openclaw/workspace'

function shellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runClawHubCommand(command) {
  return new Promise((resolve) => {
    exec(
      `cd ${shellArg(CLAWHUB_WORKSPACE)} && ${command} 2>&1`,
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, output: `${stdout || ''}${stderr || ''}` }),
    )
  })
}

function parseClawHubSearchOutput(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.match(/^(\S+)\s+(.+?)\s+\([^)]+\)\s*$/))
    .filter(Boolean)
    .map((match) => ({ slug: match[1], description: match[2].trim() }))
}

function parseSkillMarkdown(markdown) {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  const meta = { name: '', description: '' }
  if (frontmatter) {
    for (const line of frontmatter[1].split('\n')) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'name' || key === 'description') meta[key] = value
    }
  }
  return meta
}

function publicSkill(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    icon: row.icon || '🤖',
    sort_order: row.sort_order,
  }
}

function adminSkill(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    system_prompt: row.system_prompt,
    icon: row.icon || '🤖',
    is_active: row.is_active,
    sort_order: row.sort_order,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function requireSkillAdmin(request, reply) {
  const user = await one('SELECT is_admin FROM users WHERE id = $1', [request.user.id])
  if (!user?.is_admin) return reply.code(403).send({ error: 'Admin permission required' })
}

function normalizeSkillInput(body = {}, existing = null) {
  return {
    name: Object.hasOwn(body, 'name') ? String(body.name || '').trim() : existing?.name,
    description: Object.hasOwn(body, 'description') ? String(body.description || '').trim() || null : existing?.description,
    system_prompt: Object.hasOwn(body, 'system_prompt') ? String(body.system_prompt || '').trim() : existing?.system_prompt,
    icon: Object.hasOwn(body, 'icon') ? String(body.icon || '').trim() || '🤖' : existing?.icon || '🤖',
    sort_order: Object.hasOwn(body, 'sort_order') ? Number.parseInt(body.sort_order, 10) || 0 : existing?.sort_order || 0,
    is_active: Object.hasOwn(body, 'is_active') ? Boolean(body.is_active) : existing?.is_active ?? true,
  }
}

export default async function skillRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => {
    const result = await query(
      `SELECT id, name, description, icon, sort_order
       FROM skills
       WHERE is_active = true
       ORDER BY sort_order ASC, created_at ASC`,
    )
    return { skills: result.rows.map(publicSkill) }
  })
}

export async function adminSkillRoutes(app) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', requireSkillAdmin)

  app.get('/', async () => {
    const result = await query('SELECT * FROM skills ORDER BY sort_order ASC, created_at ASC')
    return { skills: result.rows.map(adminSkill) }
  })

  app.get('/clawhub/search', async (request, reply) => {
    const q = String(request.query?.q || '').trim()
    if (!q) return reply.code(400).send({ error: 'Search query is required' })

    const { error, output } = await runClawHubCommand(`npx clawhub search ${shellArg(q)} --limit 10`)
    if (error) return reply.code(500).send({ error: output.trim() || error.message })

    return { results: parseClawHubSearchOutput(output) }
  })

  app.get('/clawhub/preview', async (request, reply) => {
    const slug = String(request.query?.slug || '').trim()
    if (!slug) return reply.code(400).send({ error: 'Skill slug is required' })

    const { error, output } = await runClawHubCommand(`npx clawhub inspect ${shellArg(slug)} --file SKILL.md`)
    if (output.includes('Skill not found')) return reply.code(404).send({ error: 'Skill not found' })
    if (error) return reply.code(500).send({ error: output.trim() || error.message })

    const meta = parseSkillMarkdown(output)
    return {
      slug,
      name: meta.name,
      description: meta.description,
      system_prompt: output,
    }
  })

  app.post('/', async (request, reply) => {
    const input = normalizeSkillInput(request.body || {})
    if (!input.name || !input.system_prompt) return reply.code(400).send({ error: 'Name and system prompt are required' })

    const result = await query(
      `INSERT INTO skills (name, description, system_prompt, icon, sort_order, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.name, input.description, input.system_prompt, input.icon, input.sort_order, input.is_active, request.user.id],
    )
    return reply.code(201).send({ skill: adminSkill(result.rows[0]) })
  })

  app.patch('/:id', async (request, reply) => {
    const existing = await one('SELECT * FROM skills WHERE id = $1', [request.params.id])
    if (!existing) return reply.code(404).send({ error: 'Skill not found' })

    const input = normalizeSkillInput(request.body || {}, existing)
    if (!input.name || !input.system_prompt) return reply.code(400).send({ error: 'Name and system prompt are required' })

    const result = await query(
      `UPDATE skills
       SET name = $2,
           description = $3,
           system_prompt = $4,
           icon = $5,
           sort_order = $6,
           is_active = $7,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [request.params.id, input.name, input.description, input.system_prompt, input.icon, input.sort_order, input.is_active],
    )
    return { skill: adminSkill(result.rows[0]) }
  })

  app.delete('/:id', async (request, reply) => {
    const result = await query('DELETE FROM skills WHERE id = $1', [request.params.id])
    if (!result.rowCount) return reply.code(404).send({ error: 'Skill not found' })
    return { ok: true }
  })
}
