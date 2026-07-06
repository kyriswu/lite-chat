const LS = {
  get: (key, fallback) => { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) } catch { return fallback } },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  del: (key) => localStorage.removeItem(key),
}

let authToken = LS.get('authToken', '')
let currentUser = null

const $ = (id) => document.getElementById(id)
const refs = {
  status: $('review-status'),
  userLine: $('review-user-line'),
  form: $('review-form'),
  problemUrl: $('problem-url'),
  importProblemBtn: $('import-problem-btn'),
  problemText: $('problem-text'),
  codeText: $('code-text'),
  badge: $('review-badge'),
  empty: $('review-empty'),
  result: $('review-result'),
  meta: $('review-meta'),
  summary: $('review-summary'),
  staticFindings: $('review-static-findings'),
  deepSection: $('deep-review-section'),
  deepFindings: $('review-deep-findings'),
  compileOutput: $('compile-output'),
  runtimeOutput: $('runtime-output'),
  runtimeMeta: $('runtime-meta'),
  sanitizerOutput: $('sanitizer-output'),
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  const res = await fetch(path, { ...options, headers })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = await res.json()
      const error = data.error
      message = typeof error === 'string' ? error : error?.message || data.message || message
    } catch {
      try { message = await res.text() || message } catch {}
    }
    throw new Error(message)
  }
  return res.json()
}

function setStatus(text, error = false) {
  refs.status.textContent = text || ''
  refs.status.classList.toggle('error', Boolean(error))
}

function escHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function collectPayload() {
  return {
    cppStandard: $('cpp-standard').value,
    problemText: refs.problemText.value.trim(),
    code: refs.codeText.value,
  }
}

function extractLuoguProblemUrl(text) {
  const match = String(text || '').match(/https?:\/\/(?:www\.)?luogu\.com\.cn\/problem\/[A-Za-z0-9_-]+/i)
  return match ? match[0] : ''
}

async function importProblemFromUrl(rawUrl, { clearStatus = true } = {}) {
  const url = String(rawUrl || '').trim()
  if (!url) return setStatus('题目链接不能为空', true)

  if (clearStatus) setStatus('正在导入洛谷题面...')
  refs.importProblemBtn.disabled = true
  try {
    const payload = await api('/api/code-review/import-problem', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
    refs.problemUrl.value = payload.source?.url || url
    refs.problemText.value = payload.problemText || ''
    refs.problemText.dispatchEvent(new Event('input'))
    setStatus(`题目导入完成：${payload.meta?.title || '洛谷题面'}`)
  } catch (err) {
    setStatus(err.message, true)
  } finally {
    refs.importProblemBtn.disabled = false
  }
}

function renderMeta(review) {
  const items = [
    ['C++ 标准', review.meta?.cppStandard || '未设置'],
    ['时间限制', review.meta?.timeLimit?.raw || '未识别'],
    ['内存限制', review.meta?.memoryLimit?.raw || '未识别'],
    ['最大规模线索', review.meta?.maxConstraint ? String(review.meta.maxConstraint) : '未识别'],
  ]
  refs.meta.innerHTML = items.map(([label, value]) => `
    <div class="meta-card">
      <div class="meta-label">${escHtml(label)}</div>
      <div class="meta-value">${escHtml(value)}</div>
    </div>
  `).join('')
}

function renderSummary(review) {
  refs.summary.innerHTML = (review.summary || []).map((item) => `
    <div class="summary-card">
      <div class="summary-label">${escHtml(item.severity.toUpperCase())}</div>
      <div class="summary-value">${escHtml(item.count)}</div>
    </div>
  `).join('') || '<div class="summary-card"><div class="summary-value">无风险项</div></div>'

  refs.badge.textContent = `风险等级：${String(review.riskLevel || 'low').toUpperCase()}`
  refs.badge.className = review.riskLevel || 'low'
  refs.badge.classList.remove('hidden')
}

function renderFindings(target, findings) {
  target.innerHTML = findings?.length
    ? findings.map((item) => `
        <div class="finding-item ${escHtml(item.severity)}">
          <div class="finding-head">
            <div class="finding-title">${escHtml(item.title)}</div>
            <div class="finding-severity">${escHtml(item.category)} · ${escHtml(item.severity)}</div>
          </div>
          <div class="finding-detail">${escHtml(item.detail)}</div>
        </div>
      `).join('')
    : '<div class="finding-item low"><div class="finding-title">未发现明显问题</div></div>'
}

function renderDeep(review) {
  const deep = review.deepReview
  refs.deepSection.classList.toggle('hidden', !deep)
  if (!deep) return
  renderFindings(refs.deepFindings, deep.findings || [])
  refs.compileOutput.textContent = [
    deep.compile?.diagnostics?.length ? `诊断：${deep.compile.diagnostics.join('；')}` : '',
    deep.compile?.output || (deep.compile?.ok ? '编译通过，无额外输出。' : ''),
  ].filter(Boolean).join('\n\n')
  refs.runtimeOutput.textContent = deep.runtime?.stdout || '无运行输出'
  refs.runtimeMeta.textContent = [
    `样例输入识别：${deep.sample?.sampleInputFound ? '是' : '否'}`,
    `样例输出识别：${deep.sample?.sampleOutputFound ? '是' : '否'}`,
    `超时：${deep.runtime?.timedOut ? '是' : '否'}`,
    `退出码：${deep.runtime?.exitCode ?? '未知'}`,
    `信号：${deep.runtime?.signal || '无'}`,
    `运行时间：${deep.runtime?.timeSeconds ?? '未知'} s`,
    `峰值内存：${deep.runtime?.peakMemoryKb ? (deep.runtime.peakMemoryKb / 1024).toFixed(1) + ' MB' : '未知'}`,
    deep.runtime?.stderr ? `stderr:\n${deep.runtime.stderr}` : '',
  ].filter(Boolean).join('\n')
  refs.sanitizerOutput.textContent = [
    deep.sanitizer?.categories?.length ? `命中类型：${deep.sanitizer.categories.join('、')}` : '',
    deep.sanitizer?.output || (deep.sanitizer?.ok ? '未检测到 sanitizer 报错。' : '未生成 sanitizer 结果。'),
  ].filter(Boolean).join('\n\n')
}

function renderReview(review) {
  refs.empty.classList.add('hidden')
  refs.result.classList.remove('hidden')
  renderMeta(review)
  renderSummary(review)
  renderFindings(refs.staticFindings, review.staticReview?.findings || [])
  renderDeep(review)
}

async function submitReview(mode) {
  const payload = collectPayload()
  if (!payload.problemText) return setStatus('题目描述不能为空', true)
  if (!payload.code.trim()) return setStatus('C++ 代码不能为空', true)

  setStatus(mode === 'deep' ? '正在执行深度检查...' : '正在执行静态审查...')
  $('static-review-btn').disabled = true
  $('deep-review-btn').disabled = true
  try {
    const review = await api(`/api/code-review/${mode}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    renderReview(review)
    setStatus(mode === 'deep' ? '深度检查完成' : '静态审查完成')
  } catch (err) {
    setStatus(err.message, true)
  } finally {
    $('static-review-btn').disabled = false
    $('deep-review-btn').disabled = false
  }
}

function fillDemo() {
  refs.problemText.value = `题目描述
给定 n 个整数，求两数之和是否等于 target。

时间限制：1 秒
内存限制：256 MB

样例输入
\`\`\`
5 9
2 7 11 15 1
\`\`\`

样例输出
\`\`\`
YES
\`\`\``

  refs.codeText.value = `#include <bits/stdc++.h>
using namespace std;

int main() {
    int n, target;
    cin >> n >> target;
    vector<int> a(n);
    for (int i = 0; i < n; ++i) cin >> a[i];
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
            if (a[i] + a[j] == target) {
                cout << "YES\\n";
                return 0;
            }
        }
    }
    cout << "NO\\n";
    return 0;
}`
}

async function init() {
  if (!authToken) {
    location.href = '/'
    return
  }
  try {
    const data = await api('/api/auth/me')
    currentUser = data.user
    refs.userLine.textContent = currentUser?.email || ''
  } catch {
    LS.del('authToken')
    location.href = '/'
  }
}

$('fill-demo-btn').onclick = fillDemo
$('static-review-btn').onclick = () => submitReview('static')
$('deep-review-btn').onclick = () => submitReview('deep')
refs.importProblemBtn.onclick = () => importProblemFromUrl(refs.problemUrl.value)
refs.problemUrl.addEventListener('paste', (event) => {
  const pasted = event.clipboardData?.getData('text/plain') || ''
  const url = extractLuoguProblemUrl(pasted)
  if (!url) return
  event.preventDefault()
  refs.problemUrl.value = url
  importProblemFromUrl(url, { clearStatus: true })
})
refs.problemText.addEventListener('paste', (event) => {
  const pasted = event.clipboardData?.getData('text/plain') || ''
  const url = extractLuoguProblemUrl(pasted)
  if (!url) return
  event.preventDefault()
  refs.problemUrl.value = url
  importProblemFromUrl(url, { clearStatus: true })
})
$('logout-btn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }) } catch {}
  LS.del('authToken')
  location.href = '/'
}

init()
