import { exec } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { one, query } from '../db/index.js'

const CLAWHUB_WORKSPACE = '/root/.openclaw/workspace'
const SKILLS_STORAGE_DIR = '/root/lite-chat/uploads/skills'
const CLAWHUB_SKILLS_DIR = '/root/.openclaw/workspace/skills'

async function listFilesRecursive(dir, base) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    const rel = path.relative(base, abs)
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(abs, base))
    } else {
      results.push({ relativePath: rel, absolutePath: abs })
    }
  }
  return results
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase()
  const map = {
    '.md': 'text/markdown',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.py': 'text/x-python',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.sh': 'text/x-shellscript',
  }
  return map[ext] || 'application/octet-stream'
}

function shouldSkipClawHubFile(relativePath) {
  const name = path.basename(relativePath)
  return new Set(['SKILL.md', '_meta.json']).has(name) && path.dirname(relativePath) === '.'
}

function getClawHubSkillDir(slug) {
  const base = path.resolve(CLAWHUB_SKILLS_DIR)
  const target = path.resolve(base, slug)
  if (target !== base && target.startsWith(`${base}${path.sep}`)) return target
  console.error('[skill-files] invalid clawhub slug:', slug)
  return null
}

async function listClawHubAttachmentFiles(slug) {
  const srcDir = getClawHubSkillDir(slug)
  if (!srcDir) return []
  try {
    const files = await listFilesRecursive(srcDir, srcDir)
    return files.map((file) => file.relativePath).filter((relativePath) => !shouldSkipClawHubFile(relativePath))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[skill-files] listClawHubAttachmentFiles error:', e.message)
    return []
  }
}

async function copySkillFiles(skillId, slug) {
  const srcDir = getClawHubSkillDir(slug)
  if (!srcDir) return []
  const destDir = path.join(SKILLS_STORAGE_DIR, skillId)
  await fs.mkdir(destDir, { recursive: true })

  let files = []
  try {
    files = await listFilesRecursive(srcDir, srcDir)
  } catch (e) {
    console.error('[skill-files] listFilesRecursive error:', e.message)
    return []
  }

  const copied = []
  for (const { relativePath, absolutePath } of files) {
    if (shouldSkipClawHubFile(relativePath)) continue

    const destPath = path.join(destDir, relativePath)
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true })
      await fs.copyFile(absolutePath, destPath)
      const stat = await fs.stat(destPath)
      copied.push({
        relative_path: relativePath,
        storage_path: destPath,
        file_size: stat.size,
        mime_type: getMimeType(relativePath),
      })
    } catch (e) {
      console.error('[skill-files] copyFile error:', relativePath, e.message)
    }
  }
  return copied
}

async function getClawHubVersion(slug) {
  const srcDir = getClawHubSkillDir(slug)
  if (!srcDir) return null
  try {
    const metaText = await fs.readFile(path.join(srcDir, '_meta.json'), 'utf8')
    const meta = JSON.parse(metaText)
    return meta.version ? String(meta.version) : null
  } catch (e) {
    console.error('[skill-files] read _meta.json error:', e.message)
    return null
  }
}

async function insertSkillFiles(skillId, copied) {
  if (!copied.length) return
  const values = []
  const params = []
  copied.forEach((file, index) => {
    const offset = index * 5
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`)
    params.push(skillId, file.relative_path, file.file_size, file.mime_type, file.storage_path)
  })
  await query(
    `INSERT INTO skill_files (skill_id, relative_path, file_size, mime_type, storage_path)
     VALUES ${values.join(', ')}`,
    params,
  )
}

function isTextMime(mimeType = '') {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/javascript',
    'application/typescript',
  ].includes(mimeType)
}

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
  // clawhub inspect 输出前会有 "- Fetching skill\n" 等状态行，跳过到 --- 开始
  // 同时去掉 CRLF（Windows 换行），统一转为 LF
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const startIdx = normalized.indexOf('---')
  const cleaned = startIdx >= 0 ? normalized.slice(startIdx) : normalized
  const frontmatter = cleaned.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
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
    clawhub_slug: row.clawhub_slug || null,
    clawhub_version: row.clawhub_version || null,
    clawhub_imported_at: row.clawhub_imported_at || null,
    files_count: row.files_count || 0,
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
    const result = await query(
      `SELECT s.*, COUNT(sf.id)::int AS files_count
       FROM skills s
       LEFT JOIN skill_files sf ON sf.skill_id = s.id
       GROUP BY s.id
       ORDER BY s.sort_order ASC, s.created_at ASC`,
    )
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
      attachmentFiles: await listClawHubAttachmentFiles(slug),
    }
  })

  app.post('/', async (request, reply) => {
    const input = normalizeSkillInput(request.body || {})
    const clawhubSlug = String(request.body?.clawhub_slug || '').trim() || null
    if (!input.name || !input.system_prompt) return reply.code(400).send({ error: 'Name and system prompt are required' })

    const result = await query(
      `INSERT INTO skills (name, description, system_prompt, icon, sort_order, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.name, input.description, input.system_prompt, input.icon, input.sort_order, input.is_active, request.user.id],
    )
    let skill = { ...result.rows[0], files_count: 0 }
    if (clawhubSlug) {
      const version = await getClawHubVersion(clawhubSlug)
      const copied = await copySkillFiles(skill.id, clawhubSlug)
      try {
        await insertSkillFiles(skill.id, copied)
      } catch (e) {
        console.error('[skill-files] insert skill_files error:', e.message)
      }
      const updateResult = await query(
        `UPDATE skills
         SET clawhub_slug = $2,
             clawhub_version = $3,
             clawhub_imported_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [skill.id, clawhubSlug, version],
      )
      skill = { ...updateResult.rows[0], files_count: copied.length }
    }
    return reply.code(201).send({ skill: adminSkill(skill) })
  })

  app.get('/:id/files', async (request, reply) => {
    const existing = await one('SELECT id FROM skills WHERE id = $1', [request.params.id])
    if (!existing) return reply.code(404).send({ error: 'Skill not found' })

    const result = await query(
      `SELECT id, relative_path, file_size, mime_type, storage_path, created_at
       FROM skill_files
       WHERE skill_id = $1
       ORDER BY relative_path ASC`,
      [request.params.id],
    )
    return { files: result.rows }
  })

  app.get('/:id/files/*', async (request, reply) => {
    const relativePath = String(request.params['*'] || '').trim()
    if (!relativePath) return reply.code(400).send({ error: 'File path is required' })

    const file = await one(
      `SELECT relative_path, mime_type, storage_path
       FROM skill_files
       WHERE skill_id = $1 AND relative_path = $2`,
      [request.params.id, relativePath],
    )
    if (!file) return reply.code(404).send({ error: 'File not found' })

    try {
      const buffer = await fs.readFile(file.storage_path)
      reply.type(file.mime_type || 'application/octet-stream')
      return isTextMime(file.mime_type || '') ? buffer.toString('utf8') : buffer.toString('base64')
    } catch (e) {
      console.error('[skill-files] readFile error:', file.relative_path, e.message)
      return reply.code(500).send({ error: 'Failed to read file' })
    }
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
