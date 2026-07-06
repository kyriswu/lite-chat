import { execFile, spawn } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const CPP_STANDARDS = new Set(['c++14', 'c++17', 'c++20'])
const DEFAULT_CPP_STANDARD = 'c++14'
const MAX_PROBLEM_TEXT = 40000
const MAX_CODE_TEXT = 150000
const DEFAULT_TIME_LIMIT_SECONDS = 2
const DEFAULT_MEMORY_LIMIT_MB = 256
const LUOGU_HOSTS = new Set(['www.luogu.com.cn', 'luogu.com.cn'])
const CODEFORCES_HOSTS = new Set(['www.codeforces.com', 'codeforces.com'])
const YOSUPO_HOSTS = new Set(['judge.yosupo.jp', 'www.judge.yosupo.jp'])
const SPA_EXPLORER_ENDPOINT = 'https://coze-js-api.devtool.uk/explorer'
const SPA_EXPLORER_API_KEY = process.env.COZE_JS_EXPLORER_API_KEY || '3Zn7w4kJaF7NMcMANdinNpFt'

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function normalizeCppStandard(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return CPP_STANDARDS.has(normalized) ? normalized : DEFAULT_CPP_STANDARD
}

function normalizeReviewInput(body = {}) {
  const problemText = String(body.problemText || '').trim()
  const code = String(body.code || '')
  return {
    problemText,
    code,
    cppStandard: normalizeCppStandard(body.cppStandard),
  }
}

function normalizeProblemImportInput(body = {}) {
  return {
    url: String(body.url || '').trim(),
  }
}

function normalizeCodeforcesIndex(rawIndex) {
  return String(rawIndex || '').trim().toUpperCase()
}

function parseCodeforcesProblemPath(pathname) {
  const problemsetMatch = String(pathname || '').match(/^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)$/)
  if (problemsetMatch) {
    return {
      contestId: problemsetMatch[1],
      index: normalizeCodeforcesIndex(problemsetMatch[2]),
      canonicalPath: `/problemset/problem/${problemsetMatch[1]}/${normalizeCodeforcesIndex(problemsetMatch[2])}`,
    }
  }
  const contestMatch = String(pathname || '').match(/^\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)$/)
  if (contestMatch) {
    return {
      contestId: contestMatch[1],
      index: normalizeCodeforcesIndex(contestMatch[2]),
      canonicalPath: `/contest/${contestMatch[1]}/problem/${normalizeCodeforcesIndex(contestMatch[2])}`,
    }
  }
  return null
}

function parseYosupoProblemPath(pathname) {
  const match = String(pathname || '').match(/^\/problem\/([A-Za-z0-9._-]+)\/?$/)
  if (!match) return null
  return {
    slug: match[1],
    canonicalPath: `/problem/${match[1]}`,
  }
}

function ensureSupportedProblemUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || '').trim())
  } catch {
    throw new Error('题目链接格式不正确')
  }

  if (LUOGU_HOSTS.has(parsed.hostname)) {
    const match = parsed.pathname.match(/^\/problem\/([A-Za-z0-9_-]+)$/)
    if (!match) {
      throw new Error('当前只支持洛谷题目详情页链接')
    }
    return {
      platform: 'luogu',
      url: `${parsed.protocol}//${parsed.host}/problem/${match[1]}`,
      pid: match[1],
    }
  }

  if (CODEFORCES_HOSTS.has(parsed.hostname)) {
    const parsedPath = parseCodeforcesProblemPath(parsed.pathname)
    if (!parsedPath) {
      throw new Error('当前只支持 Codeforces 题目详情页链接')
    }
    const pid = `CF${parsedPath.contestId}${parsedPath.index}`
    return {
      platform: 'codeforces',
      url: `https://codeforces.com${parsedPath.canonicalPath}`,
      contestId: parsedPath.contestId,
      index: parsedPath.index,
      pid,
      luoguProxyUrl: `https://www.luogu.com.cn/problem/${pid}`,
    }
  }

  if (YOSUPO_HOSTS.has(parsed.hostname)) {
    const parsedPath = parseYosupoProblemPath(parsed.pathname)
    if (!parsedPath) {
      throw new Error('当前只支持 Library Checker 题目详情页链接')
    }
    return {
      platform: 'yosupo',
      url: `https://judge.yosupo.jp${parsedPath.canonicalPath}`,
      slug: parsedPath.slug,
    }
  }

  throw new Error('当前只支持导入洛谷、Codeforces 或 Library Checker 题目链接')
}

async function fetchTextWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) {
      throw new Error(`上游返回 ${response.status}`)
    }
    return await response.text()
  } catch (err) {
    if (controller.signal.aborted) throw new Error('抓取题面超时')
    // Some environments cannot reach Luogu via Node fetch due TLS/proxy stack,
    // while curl still works. Use curl as a safe fallback to improve reliability.
    return fetchTextViaCurl(url, timeoutMs)
  } finally {
    clearTimeout(timer)
  }
}

function fetchTextViaCurl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const args = [
      '-sSL',
      '--max-time',
      String(seconds),
      url,
    ]
    execFile('curl', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(error.message || '').toLowerCase()
        if (message.includes('timed out')) return reject(new Error('抓取题面超时'))
        return reject(new Error('抓取题面失败（网络不可达）'))
      }
      const html = String(stdout || '')
      if (!html.trim()) return reject(new Error('抓取题面失败（空响应）'))
      return resolve(html)
    })
  })
}

function extractLuoguContext(html) {
  const match = String(html || '').match(/<script id="lentille-context" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match?.[1]) throw new Error('未找到题面数据')
  try {
    return JSON.parse(match[1])
  } catch {
    throw new Error('题面数据解析失败')
  }
}

async function fetchSpaHtmlViaExplorer(url, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(SPA_EXPLORER_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        api_key: SPA_EXPLORER_API_KEY,
      }),
    })
    if (!response.ok) throw new Error(`上游返回 ${response.status}`)
    const payload = await response.json()
    const html = String(payload?.data?.[0]?.htmlContent || '').trim()
    if (!html) throw new Error('未返回页面源码')
    return html
  } catch (err) {
    if (controller.signal.aborted) throw new Error('SPA 源码抓取超时')
    throw new Error('SPA 源码抓取失败')
  } finally {
    clearTimeout(timer)
  }
}

function parseYosupoInfoToml(infoToml) {
  const text = String(infoToml || '')
  if (!text.trim()) {
    return {
      timeLimitSeconds: null,
      memoryLimitMb: null,
      exampleCount: 0,
    }
  }

  const readNumberByPattern = (pattern) => {
    const match = text.match(pattern)
    if (!match?.[1]) return null
    const parsed = Number.parseFloat(String(match[1]).replace(/_/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }

  const timeLimitSeconds = readNumberByPattern(/(?:^|\n)\s*(?:timelimit|time_limit)\s*=\s*([0-9_]+(?:\.[0-9_]+)?)/i)

  let memoryLimitMb = null
  const directMb = readNumberByPattern(/(?:^|\n)\s*(?:memory_limit_mb|memory_mb)\s*=\s*([0-9_]+(?:\.[0-9_]+)?)/i)
  if (directMb !== null) {
    memoryLimitMb = directMb
  } else {
    const genericMemory = readNumberByPattern(/(?:^|\n)\s*(?:memory_limit|memlimit|memory)\s*=\s*([0-9_]+(?:\.[0-9_]+)?)/i)
    if (genericMemory !== null) {
      if (genericMemory > 4096) memoryLimitMb = genericMemory / 1024 / 1024
      else memoryLimitMb = genericMemory
    }
  }

  const testBlocks = [...text.matchAll(/\[\[tests\]\]([\s\S]*?)(?=\n\s*\[\[tests\]\]|\n\s*\[[^\]]+\]|\s*$)/g)]
  let exampleCount = 0
  for (const block of testBlocks) {
    const body = String(block[1] || '')
    const nameMatch = body.match(/(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/i)
    const numberMatch = body.match(/(?:^|\n)\s*number\s*=\s*([0-9_]+)/i)
    const testName = String(nameMatch?.[1] || '').trim().toLowerCase()
    if (!testName || !testName.startsWith('example')) continue
    const count = Number.parseInt(String(numberMatch?.[1] || '').replace(/_/g, ''), 10)
    if (Number.isFinite(count) && count > 0) {
      exampleCount = Math.max(exampleCount, count)
    }
  }

  return {
    timeLimitSeconds,
    memoryLimitMb: Number.isFinite(memoryLimitMb) ? Number(memoryLimitMb) : null,
    exampleCount,
  }
}

async function fetchYosupoExamples({ slug, testcasesVersion, exampleCount }) {
  const count = Math.max(0, Math.min(10, Number(exampleCount) || 0))
  if (!slug || !testcasesVersion || !count) return []

  const examples = []
  for (let i = 0; i < count; i += 1) {
    const suffix = String(i).padStart(2, '0')
    const inputUrl = `https://storage.googleapis.com/v2-prod-library-checker-data-public/v4/examples/${slug}/${testcasesVersion}/in/example_${suffix}.in`
    const outputUrl = `https://storage.googleapis.com/v2-prod-library-checker-data-public/v4/examples/${slug}/${testcasesVersion}/out/example_${suffix}.out`

    let sampleInput = ''
    let sampleOutput = ''
    try {
      sampleInput = String(await fetchTextWithTimeout(inputUrl, 15000) || '').trimEnd()
    } catch {}
    try {
      sampleOutput = String(await fetchTextWithTimeout(outputUrl, 15000) || '').trimEnd()
    } catch {}
    if (!sampleInput && !sampleOutput) continue

    examples.push({
      sampleInput,
      sampleOutput,
    })
  }
  return examples
}

function coalesceTimeLimit(values, fallbackRaw) {
  const list = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : []
  if (!list.length) return fallbackRaw
  const max = Math.max(...list)
  return `${max / 1000} 秒`
}

function coalesceMemoryLimit(values, fallbackRaw) {
  const list = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : []
  if (!list.length) return fallbackRaw
  const max = Math.max(...list)
  return `${max / 1024} MB`
}

function buildLuoguProblemText(problem) {
  const contenu = problem?.contenu || problem?.content || {}
  const title = String(problem?.pid || '').trim()
    ? `${problem.pid} ${contenu.name || problem.name || ''}`.trim()
    : String(contenu.name || problem?.name || '').trim()
  const description = String(contenu.description || '').trim()
  const formatI = String(contenu.formatI || '').trim()
  const formatO = String(contenu.formatO || '').trim()
  const hint = String(contenu.hint || '').trim()
  const samples = Array.isArray(problem?.samples) ? problem.samples : []
  const timeLimit = coalesceTimeLimit(problem?.limits?.time, null)
  const memoryLimit = coalesceMemoryLimit(problem?.limits?.memory, null)

  const sections = []
  if (title) sections.push(title)
  if (timeLimit || memoryLimit) {
    const limitLines = []
    if (timeLimit) limitLines.push(`时间限制：${timeLimit}`)
    if (memoryLimit) limitLines.push(`内存限制：${memoryLimit}`)
    sections.push(limitLines.join('\n'))
  }
  if (description) sections.push(`题目描述\n${description}`)
  if (formatI) sections.push(`输入格式\n${formatI}`)
  if (formatO) sections.push(`输出格式\n${formatO}`)
  samples.forEach((sample, index) => {
    const sampleInput = String(sample?.[0] || '').trimEnd()
    const sampleOutput = String(sample?.[1] || '').trimEnd()
    const labelSuffix = samples.length > 1 ? ` ${index + 1}` : ''
    if (sampleInput) sections.push(`样例输入${labelSuffix}\n\`\`\`\n${sampleInput}\n\`\`\``)
    if (sampleOutput) sections.push(`样例输出${labelSuffix}\n\`\`\`\n${sampleOutput}\n\`\`\``)
  })
  if (hint) sections.push(`说明/提示\n${hint}`)

  const problemText = sections.filter(Boolean).join('\n\n').trim()
  if (!problemText) throw new Error('题面内容为空')
  return {
    problemText,
    meta: {
      pid: problem?.pid || '',
      title: contenu.name || problem?.name || '',
      sampleCount: samples.length,
      hasTimeLimit: Boolean(timeLimit),
      hasMemoryLimit: Boolean(memoryLimit),
    },
  }
}

async function importLuoguProblem(sourceUrl, options = {}) {
  const source = ensureSupportedProblemUrl(sourceUrl)
  if (source.platform !== 'luogu') {
    throw new Error('当前仅支持洛谷题目解析')
  }
  const html = await fetchTextWithTimeout(source.url, 15000)
  const context = extractLuoguContext(html)
  const problem = context?.data?.problem
  if (!problem) throw new Error('未找到题目主体')
  const extracted = buildLuoguProblemText(problem)
  return {
    source,
    ...extracted,
  }
}

async function importCodeforcesProblem(sourceUrl, options = {}) {
  const source = ensureSupportedProblemUrl(sourceUrl)
  if (source.platform !== 'codeforces') {
    throw new Error('当前仅支持 Codeforces 题目解析')
  }
  // Codeforces 在部分网络环境会触发 Cloudflare 校验，这里复用 Luogu 的 CF 题镜像页进行解析。
  const extracted = await importLuoguProblem(source.luoguProxyUrl)
  return {
    source,
    problemText: extracted.problemText,
    meta: {
      ...(extracted.meta || {}),
      pid: source.pid,
      sourcePlatform: 'codeforces',
      sourceUrl: source.url,
      mirrorUrl: source.luoguProxyUrl,
    },
  }
}

async function importYosupoProblem(sourceUrl, options = {}) {
  const source = ensureSupportedProblemUrl(sourceUrl)
  if (source.platform !== 'yosupo') {
    throw new Error('当前仅支持 Library Checker 题目解析')
  }

  const metaUrl = `https://v3.api.judge.yosupo.jp/problems/${source.slug}`
  let meta = null
  try {
    meta = await fetchTextWithTimeout(metaUrl, 15000).then((raw) => JSON.parse(raw))
  } catch {
    meta = null
  }

  const title = String(meta?.title || source.slug).trim()
  const overallVersion = String(meta?.overall_version || '').trim()
  const testcasesVersion = String(meta?.testcases_version || '').trim()
  let taskUrl = ''
  let infoUrl = ''
  let infoToml = ''
  if (overallVersion) {
    taskUrl = `https://storage.googleapis.com/v2-prod-library-checker-data-public/v4/files/${source.slug}/${overallVersion}/${source.slug}/task.md`
    infoUrl = `https://storage.googleapis.com/v2-prod-library-checker-data-public/v4/files/${source.slug}/${overallVersion}/${source.slug}/info.toml`
  }

  if (!taskUrl || !infoUrl) {
    const html = await fetchSpaHtmlViaExplorer(source.url, 20000)
    const match = html.match(new RegExp(`https://storage\.googleapis\.com/v2-prod-library-checker-data-public/v4/files/${source.slug}/[^"'\\s)]+/${source.slug}/task\\.md`, 'i'))
    const infoMatch = html.match(new RegExp(`https://storage\\.googleapis\\.com/v2-prod-library-checker-data-public/v4/files/${source.slug}/[^"'\\s)]+/${source.slug}/info\\.toml`, 'i'))
    taskUrl = String(match?.[0] || '').trim()
    infoUrl = String(infoMatch?.[0] || '').trim()
  }
  if (!taskUrl) {
    throw new Error('Library Checker 题面地址解析失败')
  }

  let taskMarkdown = ''
  try {
    taskMarkdown = String(await fetchTextWithTimeout(taskUrl, 15000) || '').trim()
  } catch {
    throw new Error('Library Checker 题面抓取失败')
  }
  if (!taskMarkdown) {
    throw new Error('Library Checker 题面内容为空')
  }

  if (infoUrl) {
    try {
      infoToml = String(await fetchTextWithTimeout(infoUrl, 15000) || '')
    } catch {
      infoToml = ''
    }
  }

  const infoSummary = parseYosupoInfoToml(infoToml)
  const sampleCount = infoSummary.exampleCount
  const examples = await fetchYosupoExamples({
    slug: source.slug,
    testcasesVersion,
    exampleCount: sampleCount,
  })

  const sections = []
  if (title) sections.push(`${source.slug} ${title}`.trim())
  const timeLimitSeconds = Number.isFinite(Number(meta?.time_limit))
    ? Number(meta.time_limit)
    : infoSummary.timeLimitSeconds
  const memoryLimitMb = infoSummary.memoryLimitMb
  const limitLines = []
  if (timeLimitSeconds !== null) limitLines.push(`时间限制：${timeLimitSeconds} 秒`)
  if (memoryLimitMb !== null) limitLines.push(`内存限制：${Number(memoryLimitMb).toFixed(memoryLimitMb % 1 === 0 ? 0 : 2)} MB`)
  else limitLines.push('内存限制：未提供')
  if (limitLines.length) sections.push(limitLines.join('\n'))
  sections.push(`题目描述\n${taskMarkdown}`)

  examples.forEach((sample, index) => {
    const suffix = examples.length > 1 ? ` ${index + 1}` : ''
    if (sample.sampleInput) {
      sections.push(`样例输入${suffix}\n\`\`\`\n${sample.sampleInput}\n\`\`\``)
    }
    if (sample.sampleOutput) {
      sections.push(`样例输出${suffix}\n\`\`\`\n${sample.sampleOutput}\n\`\`\``)
    }
  })

  return {
    source,
    problemText: sections.join('\n\n').trim(),
    meta: {
      pid: source.slug,
      title,
      sourcePlatform: 'yosupo',
      sourceUrl: source.url,
      taskUrl,
      infoUrl,
      sampleCount: examples.length,
    },
  }
}

async function importProblemByUrl(rawUrl) {
  const source = ensureSupportedProblemUrl(rawUrl)
  if (source.platform === 'luogu') return importLuoguProblem(source.url)
  if (source.platform === 'codeforces') return importCodeforcesProblem(source.url)
  if (source.platform === 'yosupo') return importYosupoProblem(source.url)
  throw new Error('暂不支持该题目链接')
}

function parseTimeLimit(problemText) {
  const patterns = [
    /时间限制[^\n:：]*[:：]?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|sec|secs|second|seconds|秒)/i,
    /time limit[^\n:：]*[:：]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?)/i,
  ]
  for (const pattern of patterns) {
    const match = problemText.match(pattern)
    if (!match) continue
    const value = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    const seconds = unit.startsWith('ms') || unit.includes('毫秒')
      ? value / 1000
      : value
    return {
      raw: match[0].trim(),
      seconds: clamp(seconds, 0.05, 30),
    }
  }
  return {
    raw: '未识别',
    seconds: DEFAULT_TIME_LIMIT_SECONDS,
  }
}

function parseMemoryLimit(problemText) {
  const patterns = [
    /内存限制[^\n:：]*[:：]?\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|gib|字节|b)/i,
    /memory limit[^\n:：]*[:：]?\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|gib|bytes?|b)/i,
  ]
  for (const pattern of patterns) {
    const match = problemText.match(pattern)
    if (!match) continue
    const value = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    let mb = value
    if (unit === 'kb' || unit === 'kib') mb = value / 1024
    else if (unit === 'gb' || unit === 'gib') mb = value * 1024
    else if (unit === 'b' || unit.includes('字节') || unit.startsWith('byte')) mb = value / 1024 / 1024
    return {
      raw: match[0].trim(),
      megabytes: clamp(mb, 8, 4096),
    }
  }
  return {
    raw: '未识别',
    megabytes: DEFAULT_MEMORY_LIMIT_MB,
  }
}

function extractLabeledText(problemText, labels, stopLabels) {
  const lower = problemText.toLowerCase()
  for (const label of labels) {
    const index = lower.indexOf(label.toLowerCase())
    if (index < 0) continue
    const rest = problemText.slice(index + label.length)
    const fenced = rest.match(/^[^\n]*\n```(?:[\w+-]+)?\n([\s\S]*?)```/m)
    if (fenced?.[1]?.trim()) return fenced[1].trim()
    const lines = rest.split('\n').slice(1)
    const collected = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (stopLabels.some((stop) => trimmed.toLowerCase().startsWith(stop.toLowerCase()))) break
      if (!trimmed && collected.length && !collected.at(-1)) break
      collected.push(line)
      if (collected.length >= 30) break
    }
    const text = collected.join('\n').trim()
    if (text) return text
  }
  return ''
}

function extractSamples(problemText) {
  const sampleInput = extractLabeledText(
    problemText,
    ['样例输入', '输入样例', 'sample input', 'input sample'],
    ['样例输出', '输出样例', 'sample output', 'output sample'],
  )
  const sampleOutput = extractLabeledText(
    problemText,
    ['样例输出', '输出样例', 'sample output', 'output sample'],
    ['样例解释', 'explanation', '说明'],
  )
  return { sampleInput, sampleOutput }
}

function estimateMaxConstraint(problemText) {
  const scientific = [...problemText.matchAll(/(\d+)\s*\^\s*(\d+)/g)]
    .map((match) => Number(match[1]) ** Number(match[2]))
  const compact = [...problemText.matchAll(/\b(\d+(?:\.\d+)?)\s*e\s*([+-]?\d+)\b/gi)]
    .map((match) => Number(match[1]) * (10 ** Number(match[2])))
  const plain = [...problemText.matchAll(/\b\d{4,}\b/g)].map((match) => Number(match[0]))
  return [...scientific, ...compact, ...plain].filter(Number.isFinite).sort((a, b) => b - a)[0] || null
}

function evaluateNumericExpression(value) {
  const expr = String(value || '').replace(/\s+/g, '')
  if (!expr || !/^[\d.eE()+\-*/]+$/.test(expr)) return null
  try {
    const result = Function(`"use strict"; return (${expr});`)()
    return Number.isFinite(result) ? result : null
  } catch {
    return null
  }
}

function bytesPerType(typeName) {
  const type = typeName.toLowerCase()
  if (type.includes('long long')) return 8
  if (type === 'double') return 8
  if (type === 'long double') return 16
  if (type === 'char') return 1
  if (type === 'bool') return 1
  return 4
}

function estimateArrayBytes(code) {
  const matches = [...code.matchAll(/\b(int|long long|double|char|bool)\s+([A-Za-z_]\w*)\s*\[\s*([^\]]+)\s*\](?:\s*\[\s*([^\]]+)\s*\])?/g)]
  return matches.map((match) => {
    const dim1 = evaluateNumericExpression(match[3])
    const dim2 = evaluateNumericExpression(match[4] || '1')
    if (!dim1 || !dim2) return null
    return {
      name: match[2],
      bytes: dim1 * dim2 * bytesPerType(match[1]),
    }
  }).filter(Boolean)
}

function pushFinding(findings, severity, category, title, detail) {
  findings.push({ severity, category, title, detail })
}

function truncateText(value, max = 1200) {
  const text = String(value || '').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`
}

function summarizeSampleDifference(expected, actual) {
  const expectedLines = String(expected || '').trim().split('\n')
  const actualLines = String(actual || '').trim().split('\n')
  const max = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < max; index += 1) {
    if ((expectedLines[index] || '') !== (actualLines[index] || '')) {
      return {
        line: index + 1,
        expected: expectedLines[index] || '',
        actual: actualLines[index] || '',
      }
    }
  }
  return null
}

function classifyCompileOutput(output) {
  const text = String(output || '')
  const diagnostics = []
  if (/no matching function for call|candidate expects/i.test(text)) diagnostics.push('函数调用签名不匹配')
  if (/was not declared in this scope|undeclared/i.test(text)) diagnostics.push('变量或函数未声明')
  if (/expected ['"`].+['"`]/i.test(text)) diagnostics.push('语法错误或括号缺失')
  if (/cannot convert|invalid conversion/i.test(text)) diagnostics.push('类型转换错误')
  if (/warning:/i.test(text)) diagnostics.push('存在编译告警')
  return diagnostics
}

function classifyRuntimeIssue(runtime, timeLimit, memoryLimitMb) {
  if (!runtime) return null
  if (runtime.timedOut || runtime.exitCode === 124) {
    return {
      kind: 'tle',
      title: '超时终止',
      detail: `程序在 ${Math.ceil(timeLimit * 1.5)}s 的受限运行窗口内未结束，存在明显 TLE 风险。`,
    }
  }
  if (runtime.peakMemoryKb && runtime.peakMemoryKb > memoryLimitMb * 1024) {
    return {
      kind: 'mle',
      title: '内存超限',
      detail: `峰值内存约 ${(runtime.peakMemoryKb / 1024).toFixed(1)} MB，已超过题面内存限制 ${memoryLimitMb} MB。`,
    }
  }
  if (runtime.signal === 'SIGSEGV' || /segmentation fault/i.test(runtime.stderr || '')) {
    return {
      kind: 'segfault',
      title: '段错误',
      detail: '程序在运行时出现段错误，优先检查数组越界、空指针或非法下标。',
    }
  }
  if (runtime.signal === 'SIGABRT' || /terminate called|aborted/i.test(runtime.stderr || '')) {
    return {
      kind: 'abort',
      title: '异常终止',
      detail: '程序被主动中止，可能来自断言失败、sanitizer 触发或标准库边界检查。',
    }
  }
  if (runtime.exitCode && runtime.exitCode !== 0) {
    return {
      kind: 'runtime_error',
      title: '非零退出',
      detail: `程序以退出码 ${runtime.exitCode} 结束，需要结合 stderr 继续定位。`,
    }
  }
  return null
}

function classifySanitizerOutput(output) {
  const text = String(output || '')
  const categories = []
  if (/heap-buffer-overflow|stack-buffer-overflow|global-buffer-overflow/i.test(text)) categories.push('数组越界')
  if (/use-after-free/i.test(text)) categories.push('释放后继续访问')
  if (/double-free/i.test(text)) categories.push('重复释放')
  if (/signed integer overflow/i.test(text)) categories.push('有符号整数溢出')
  if (/division by zero/i.test(text)) categories.push('除零')
  if (/null pointer/i.test(text)) categories.push('空指针访问')
  if (/misaligned address/i.test(text)) categories.push('未对齐访问')
  if (/runtime error:/i.test(text) && !categories.length) categories.push('未定义行为')
  return categories
}

function analyzeStatic(problemText, code, cppStandard) {
  const findings = []
  const timeLimit = parseTimeLimit(problemText)
  const memoryLimit = parseMemoryLimit(problemText)
  const maxConstraint = estimateMaxConstraint(problemText)
  const arrayEstimates = estimateArrayBytes(code)

  if (/\bnew\s+|\bmalloc\s*\(/.test(code)) {
    pushFinding(findings, 'medium', 'memory', '存在手动堆内存分配', '代码使用了 `new` 或 `malloc`。算法竞赛里这通常不是必需路径，也更容易引入泄漏或释放遗漏。')
    if (!/\bdelete\b|\bfree\s*\(/.test(code)) {
      pushFinding(findings, 'high', 'memory', '疑似内存泄漏', '检测到了手动分配，但没有明显的 `delete` 或 `free`。')
    }
  }

  const maybeUninitialized = [...code.matchAll(/^\s*(?:int|long long|double|char|bool)\s+([A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w+)*\s*;/gm)]
  if (maybeUninitialized.length) {
    pushFinding(findings, 'medium', 'correctness', '存在未初始化变量声明', '检测到未直接初始化的基础类型变量。竞赛代码里这类变量一旦参与比较、转移或答案输出，风险很高。')
  }

  const localLargeArray = arrayEstimates.find((item) => item.bytes > 16 * 1024 * 1024)
  if (localLargeArray) {
    pushFinding(findings, 'high', 'memory', '大数组风险', `检测到数组 \`${localLargeArray.name}\` 估算大小约 ${(localLargeArray.bytes / 1024 / 1024).toFixed(1)} MB。若它是局部变量，可能直接打爆栈。`)
  }

  const totalArrayBytes = arrayEstimates.reduce((sum, item) => sum + item.bytes, 0)
  if (totalArrayBytes > memoryLimit.megabytes * 1024 * 1024 * 0.6) {
    pushFinding(findings, 'high', 'memory', '接近内存限制', `静态估算数组总占用约 ${(totalArrayBytes / 1024 / 1024).toFixed(1)} MB，在题面内存限制 ${memoryLimit.megabytes} MB 下风险偏高。`)
  }

  const loopCount = (code.match(/\bfor\s*\(|\bwhile\s*\(/g) || []).length
  if (maxConstraint && maxConstraint >= 100000 && loopCount >= 2) {
    pushFinding(findings, 'high', 'performance', 'TLE 风险偏高', `题面里疑似存在 ${maxConstraint.toExponential()} 级别数据范围，而代码中有较多循环结构。需要重点核对是否落在 O(n log n) 或更优。`)
  } else if (maxConstraint && maxConstraint >= 1000000 && loopCount >= 1) {
    pushFinding(findings, 'medium', 'performance', '复杂度需要人工复核', `题目规模较大（约 ${maxConstraint.toExponential()}），请确认核心循环不是 O(n^2) 级别。`)
  }

  if (/\bcin\b|\bcout\b/.test(code) && !/sync_with_stdio\s*\(\s*false\s*\)|tie\s*\(\s*nullptr\s*\)/.test(code) && maxConstraint && maxConstraint >= 100000) {
    pushFinding(findings, 'medium', 'performance', 'IO 优化缺失', '代码使用了 `cin/cout`，但没有明显关闭同步或解绑 `tie`。在大输入下可能拖慢运行时间。')
  }

  if (/\bvector<.*>\s+\w+\(\s*\w+\s*\)/.test(code) && /n\s*\+\s*1|1\s*<<\s*\w+/.test(problemText) === false && maxConstraint && maxConstraint >= 1000000) {
    pushFinding(findings, 'medium', 'memory', '动态容器容量需要复核', '题目规模较大，`vector` 或其他动态容器的容量增长策略可能带来额外内存压力。')
  }

  if (/\b(int)\b/.test(code) && /(\*|sum|dist|ans|cost|dp)/i.test(code) && maxConstraint && maxConstraint >= 100000) {
    pushFinding(findings, 'medium', 'correctness', '整数溢出风险', '题目规模较大且代码中大量使用 `int`。累加、乘法、距离或答案统计建议优先复核 `long long`。')
  }

  const recursiveFunctions = [...code.matchAll(/\b(?:int|long long|void|bool|double|string)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g)]
    .map((match) => match[1])
    .filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(code.replace(matchFunctionHeader(name), '')))
  if (recursiveFunctions.length && maxConstraint && maxConstraint >= 100000) {
    pushFinding(findings, 'medium', 'stack', '递归深度风险', `检测到递归函数 ${recursiveFunctions.join(', ')}。若树/图深度接近数据规模，可能爆栈。`)
  }

  if (cppStandard === 'c++14' && /\bstructured_bindings\b|\[.*\]\s*=/.test(code)) {
    pushFinding(findings, 'high', 'compatibility', 'C++ 标准不兼容', '代码疑似使用了结构化绑定，但当前编译标准选择的是 C++14。')
  }

  if (/memset\s*\(\s*\w+\s*,\s*-1\s*,/i.test(code) && /\b(long long|double)\b/.test(code)) {
    pushFinding(findings, 'medium', 'correctness', 'memset 用法可疑', '对非字节类型数组使用 `memset(..., -1, ...)` 很容易得到非预期值。')
  }

  if (/\bpriority_queue\s*</.test(code) && /dijkstra|最短路/i.test(problemText) && !/\bpair<\s*long long|greater\s*</.test(code)) {
    pushFinding(findings, 'low', 'algorithm', '最短路实现细节建议复核', '如果这是 Dijkstra，请确认堆内键值类型和小根堆写法正确。')
  }

  if (!findings.length) {
    pushFinding(findings, 'low', 'summary', '未发现显著静态风险', '从规则扫描角度看，没有立即暴露出的高风险项，但复杂度与边界仍建议结合题面人工复核。')
  }

  return {
    parsed: {
      cppStandard,
      timeLimit,
      memoryLimit,
      maxConstraint,
    },
    findings,
  }
}

function matchFunctionHeader(name) {
  return new RegExp(`\\b(?:int|long long|void|bool|double|string)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
}

function computeRiskLevel(staticFindings, deepFindings = []) {
  const severities = [...staticFindings, ...deepFindings].map((item) => item.severity)
  if (severities.includes('critical')) return 'critical'
  if (severities.includes('high')) return 'high'
  if (severities.includes('medium')) return 'medium'
  return 'low'
}

function summarizeReview(staticFindings, deepFindings = []) {
  const counts = ['critical', 'high', 'medium', 'low'].map((severity) => ({
    severity,
    count: [...staticFindings, ...deepFindings].filter((item) => item.severity === severity).length,
  }))
  return counts.filter((item) => item.count > 0)
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 15000
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: 'pipe',
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  if (options.input) child.stdin.end(options.input)
  else child.stdin.end()

  const killTimer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(killTimer))

  return { ...result, stdout, stderr, timedOut }
}

function sanitizeCompileOutput(output) {
  return String(output || '').trim()
}

function parseTimeMarker(stderr) {
  const match = stderr.match(/__LITECHAT_TIME__([0-9.]+)\s+(\d+)/)
  if (!match) return { timeSeconds: null, peakMemoryKb: null, stderr }
  return {
    timeSeconds: Number.parseFloat(match[1]),
    peakMemoryKb: Number.parseInt(match[2], 10),
    stderr: stderr.replace(match[0], '').trim(),
  }
}

function extractSampleMeta(problemText) {
  const { sampleInput, sampleOutput } = extractSamples(problemText)
  return {
    sampleInput,
    sampleOutput,
    sampleInputFound: Boolean(sampleInput),
    sampleOutputFound: Boolean(sampleOutput),
  }
}

async function runDeepReview(input) {
  const staticReview = analyzeStatic(input.problemText, input.code, input.cppStandard)
  const sampleMeta = extractSampleMeta(input.problemText)
  const timeLimit = staticReview.parsed.timeLimit.seconds
  const memoryLimitMb = staticReview.parsed.memoryLimit.megabytes
  const tempDir = await mkdtemp(join(tmpdir(), 'lite-chat-review-'))
  const sourcePath = join(tempDir, 'main.cpp')
  const binaryPath = join(tempDir, 'review-bin')
  const sanitizerPath = join(tempDir, 'review-san')
  const samplePath = join(tempDir, 'sample.in')
  const deepFindings = []

  try {
    await writeFile(sourcePath, input.code, 'utf8')
    await writeFile(samplePath, sampleMeta.sampleInput || '', 'utf8')

    const compile = await runProcess(
      '/usr/bin/g++',
      ['-std=' + input.cppStandard, '-O2', '-Wall', '-Wextra', '-Wshadow', '-Wconversion', sourcePath, '-o', binaryPath],
      { timeoutMs: 20000 },
    )
    const compileOutput = [compile.stdout, compile.stderr].filter(Boolean).join('\n').trim()
    if (compile.code !== 0) {
      pushFinding(deepFindings, 'critical', 'compile', '编译失败', '代码无法通过编译，深度检查提前结束。')
      return {
        staticReview,
        deepReview: {
          compile: {
            ok: false,
            output: sanitizeCompileOutput(compileOutput),
            diagnostics: classifyCompileOutput(compileOutput),
          },
          runtime: null,
          sanitizer: null,
          findings: deepFindings,
          sample: sampleMeta,
        },
      }
    }
    if (compileOutput) {
      pushFinding(deepFindings, 'medium', 'compile', '存在编译告警', '编译器输出了告警，建议优先处理可能的类型转换、遮蔽和未使用变量问题。')
    }

    const sanitizerCompile = await runProcess(
      '/usr/bin/g++',
      ['-std=' + input.cppStandard, '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', sourcePath, '-o', sanitizerPath],
      { timeoutMs: 25000 },
    )
    const sanitizerCompileOutput = [sanitizerCompile.stdout, sanitizerCompile.stderr].filter(Boolean).join('\n').trim()

    const timeoutSeconds = clamp(Math.ceil(timeLimit * 1.5), 1, 10)
    const virtualMemoryKb = Math.ceil(memoryLimitMb * 1024 * 1.2)
    const runtime = await runProcess(
      '/usr/bin/bash',
      ['-lc', `ulimit -v ${virtualMemoryKb}; /usr/bin/time -f "__LITECHAT_TIME__%e %M" /usr/bin/timeout ${timeoutSeconds}s "${binaryPath}" < "${samplePath}"`],
      { cwd: tempDir, timeoutMs: (timeoutSeconds + 2) * 1000 },
    )
    const runtimeMeta = parseTimeMarker(runtime.stderr)
    const runtimeResult = {
      exitCode: runtime.code,
      signal: runtime.signal,
      timedOut: runtime.timedOut || runtime.code === 124,
      stdout: runtime.stdout.trim(),
      stderr: runtimeMeta.stderr,
      timeSeconds: runtimeMeta.timeSeconds,
      peakMemoryKb: runtimeMeta.peakMemoryKb,
    }

    const runtimeIssue = classifyRuntimeIssue(runtimeResult, timeLimit, memoryLimitMb)
    if (runtimeIssue?.kind === 'tle') {
      pushFinding(deepFindings, 'high', 'performance', runtimeIssue.title, runtimeIssue.detail)
    } else if (runtimeMeta.timeSeconds !== null && runtimeMeta.timeSeconds > timeLimit) {
      pushFinding(deepFindings, 'high', 'performance', '样例运行时间超出题面限制', `样例执行约 ${runtimeMeta.timeSeconds.toFixed(3)}s，已超过题面时间限制 ${timeLimit}s。`)
    }

    if (runtimeMeta.peakMemoryKb !== null && runtimeMeta.peakMemoryKb > memoryLimitMb * 1024) {
      pushFinding(deepFindings, 'high', 'memory', '样例运行内存超限', `样例峰值内存约 ${(runtimeMeta.peakMemoryKb / 1024).toFixed(1)} MB，已超过题面限制 ${memoryLimitMb} MB。`)
    }

    if (runtimeIssue && runtimeIssue.kind !== 'tle' && runtimeIssue.kind !== 'mle') {
      pushFinding(deepFindings, 'critical', 'runtime', runtimeIssue.title, runtimeIssue.detail)
    }

    if (!sampleMeta.sampleInputFound) {
      pushFinding(deepFindings, 'medium', 'runtime', '未识别到样例输入', '深度检查用空输入运行。TLE/MLE 结论更偏向环境和代码结构，不代表完整数据点表现。')
    }

    if (sampleMeta.sampleOutputFound) {
      const actual = runtime.stdout.trim()
      const expected = sampleMeta.sampleOutput.trim()
      if (actual !== expected) {
        const diff = summarizeSampleDifference(expected, actual)
        pushFinding(
          deepFindings,
          'medium',
          'correctness',
          '样例输出不匹配',
          diff
            ? `第 ${diff.line} 行开始出现差异。期望：${diff.expected || '<empty>'}；实际：${diff.actual || '<empty>'}。`
            : '程序运行结果与题面样例输出不一致。',
        )
      }
    }

    let sanitizer = null
    if (sanitizerCompile.code === 0) {
      const san = await runProcess(
        '/usr/bin/bash',
        ['-lc', `/usr/bin/timeout ${timeoutSeconds}s "${sanitizerPath}" < "${samplePath}"`],
        { cwd: tempDir, timeoutMs: (timeoutSeconds + 2) * 1000 },
      )
      sanitizer = {
        ok: san.code === 0 && !san.timedOut,
        output: [san.stdout, san.stderr].filter(Boolean).join('\n').trim(),
        categories: classifySanitizerOutput([san.stdout, san.stderr].filter(Boolean).join('\n').trim()),
      }
      if (/AddressSanitizer|runtime error:|undefined-behavior/i.test(sanitizer.output)) {
        const categoryText = sanitizer.categories?.length ? ` 命中类型：${sanitizer.categories.join('、')}。` : ''
        pushFinding(deepFindings, 'critical', 'sanitizer', 'Sanitizer 报错', `运行时检测到了内存越界、未定义行为或相关严重错误。${categoryText}`)
      }
    } else {
      sanitizer = {
        ok: false,
        output: sanitizeCompileOutput(sanitizerCompileOutput),
        categories: [],
      }
    }

    return {
      staticReview,
      deepReview: {
        compile: {
          ok: true,
          output: sanitizeCompileOutput(compileOutput),
          diagnostics: classifyCompileOutput(compileOutput),
        },
        runtime: runtimeResult,
        sanitizer,
        findings: deepFindings,
        sample: sampleMeta,
      },
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

function buildResponse(review) {
  return {
    meta: {
      cppStandard: review.staticReview.parsed.cppStandard,
      timeLimit: review.staticReview.parsed.timeLimit,
      memoryLimit: review.staticReview.parsed.memoryLimit,
      maxConstraint: review.staticReview.parsed.maxConstraint,
    },
    riskLevel: computeRiskLevel(review.staticReview.findings, review.deepReview?.findings || []),
    summary: summarizeReview(review.staticReview.findings, review.deepReview?.findings || []),
    staticReview: review.staticReview,
    deepReview: review.deepReview || null,
  }
}

async function handleImportProblem(rawUrl, reply) {
  const input = normalizeProblemImportInput({ url: rawUrl })
  if (!input.url) return reply.code(400).send({ error: '题目链接不能为空' })
  try {
    return await importProblemByUrl(input.url)
  } catch (err) {
    const message = err?.message || '题目导入失败'
    const statusCode = /格式不正确|只支持/.test(message)
      ? 400
      : /未找到|解析失败|内容为空/.test(message)
        ? 422
        : /超时|上游返回|网络不可达/.test(message)
          ? 502
          : 500
    return reply.code(statusCode).send({ error: message })
  }
}

export async function publicCodeReviewRoutes(app) {
  app.post('/import-problem-preview', async (request, reply) => {
    return handleImportProblem(request.body?.url, reply)
  })
}

export default async function codeReviewRoutes(app) {
  app.addHook('preHandler', app.authenticate)

  app.post('/import-problem', async (request, reply) => {
    return handleImportProblem(request.body?.url, reply)
  })

  app.post('/static', async (request, reply) => {
    const input = normalizeReviewInput(request.body)
    if (!input.problemText) return reply.code(400).send({ error: '题目描述不能为空' })
    if (!input.code.trim()) return reply.code(400).send({ error: 'C++ 代码不能为空' })
    if (input.problemText.length > MAX_PROBLEM_TEXT) return reply.code(400).send({ error: '题目描述过长' })
    if (input.code.length > MAX_CODE_TEXT) return reply.code(400).send({ error: '代码内容过长' })

    const staticReview = analyzeStatic(input.problemText, input.code, input.cppStandard)
    return buildResponse({ staticReview, deepReview: null })
  })

  app.post('/deep', async (request, reply) => {
    const input = normalizeReviewInput(request.body)
    if (!input.problemText) return reply.code(400).send({ error: '题目描述不能为空' })
    if (!input.code.trim()) return reply.code(400).send({ error: 'C++ 代码不能为空' })
    if (input.problemText.length > MAX_PROBLEM_TEXT) return reply.code(400).send({ error: '题目描述过长' })
    if (input.code.length > MAX_CODE_TEXT) return reply.code(400).send({ error: '代码内容过长' })

    const review = await runDeepReview(input)
    return buildResponse(review)
  })
}
