const LS = {
  get: (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v) } catch { return fallback } },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  del: (key) => localStorage.removeItem(key),
}

let authToken = LS.get('authToken', '')
let currentUser = null
let adminProviders = []
let adminSkills = []
let adminSkillFiles = {}
let adminUsers = []
let adminDashboard = null
let adminSettings = null
let adminConversationDetails = {}
let expandedConversationId = ''
let trendChartInstance = null
let modelUsageChartInstance = null

const $ = (id) => document.getElementById(id)
const refs = {
  userLine: $('admin-user-line'), status: $('admin-status'), pageTitle: $('page-title'), pageSubtitle: $('page-subtitle'),
  stats: $('admin-stats'), recentUsers: $('admin-recent-users'), recentConversations: $('admin-recent-conversations'),
  trendChart: $('admin-trend-chart'), modelUsage: $('admin-model-usage'), topUsers: $('admin-top-users'),
  topConversations: $('admin-top-conversations'), modelTable: $('admin-model-table'),
  providerList: $('admin-provider-list'), providerForm: $('admin-provider-form'),
  skillList: $('admin-skill-list'), skillForm: $('admin-skill-form'),
  settingsForm: $('admin-settings-form'),
  userList: $('admin-user-list'),
  userCreateForm: $('admin-user-create-form'),
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
      message = data.error || data.message || message
    } catch {
      try { message = await res.text() || message } catch {}
    }
    throw new Error(message)
  }
  if (res.status === 204) return null
  return res.json()
}

function setStatus(text, error = false) {
  refs.status.textContent = text || ''
  refs.status.classList.toggle('error', Boolean(error))
}

function escHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;')
}

function formatDateTime(value) {
  if (!value) return '从未'
  try { return new Date(value).toLocaleString('zh-CN', { hour12: false }) } catch { return String(value) }
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}

function formatTokens(value) {
  const num = Number(value || 0)
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return String(num)
}

function metricDelta(currentRaw, previousRaw) {
  const current = Math.max(0, Number(currentRaw || 0))
  const previous = Math.max(0, Number(previousRaw || 0))
  if (!current && !previous) return { text: '暂无变化', cls: 'neutral' }
  if (!previous) return { text: '+100.0% ↑', cls: 'up' }
  const delta = ((current - previous) / previous) * 100
  if (Math.abs(delta) < 0.05) return { text: '0.0% →', cls: 'neutral' }
  const up = delta > 0
  return {
    text: `${up ? '+' : ''}${delta.toFixed(1)}% ${up ? '↑' : '↓'}`,
    cls: up ? 'up' : 'down',
  }
}

function hashString(text) {
  let hash = 0
  const source = String(text || '')
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function avatarFromText(text) {
  const source = String(text || '').trim() || 'U'
  const initial = source[0].toUpperCase()
  const seed = hashString(source)
  const hueA = seed % 360
  const hueB = (hueA + 42) % 360
  const style = `background: linear-gradient(135deg, hsl(${hueA}, 72%, 54%), hsl(${hueB}, 72%, 45%));`
  return `<span class="avatar" style="${style}">${escHtml(initial)}</span>`
}

function empty(text) {
  return `<div class="empty-state">${escHtml(text)}</div>`
}

function setTab(tab) {
  const titles = {
    dashboard: ['看板', '系统数据概览'],
    providers: ['供应商', '配置全局模型 Provider'],
    skills: ['技能', '管理全局技能和默认开启项'],
    settings: ['设置', '管理全局聊天行为'],
    users: ['用户', '查看和管理用户账号'],
  }
  for (const btn of document.querySelectorAll('.nav-btn')) btn.classList.toggle('active', btn.dataset.tab === tab)
  for (const pane of document.querySelectorAll('.admin-pane')) pane.classList.toggle('hidden', pane.id !== `pane-${tab}`)
  refs.pageTitle.textContent = titles[tab]?.[0] || '管理员'
  refs.pageSubtitle.textContent = titles[tab]?.[1] || ''
  if (tab === 'dashboard') loadAdminDashboard().catch(showError)
  if (tab === 'providers') loadAdminProviders().catch(showError)
  if (tab === 'skills') loadAdminSkills().catch(showError)
  if (tab === 'settings') loadAdminSettings().catch(showError)
  if (tab === 'users') loadAdminUsers().catch(showError)
}

function showError(err) {
  setStatus(err.message || String(err), true)
}

function renderAdminDashboard() {
  const totals = adminDashboard?.totals || {}
  const totalTokens = Number(totals.total_tokens || 0)
  const tokens24h = Number(totals.tokens_24h || 0)
  const totalConversations = Number(totals.conversations || 0)
  const conversations24h = Number(totals.conversations_24h || 0)
  const totalUsers = Number(totals.users || 0)
  const activeUsers = Number(totals.active_users_7d || 0)
  const totalMessages = Number(totals.messages || 0)
  const messages24h = Number(totals.messages_24h || 0)

  const stats = [
    { label: '总 Token', value: formatTokens(totalTokens), size: 'lg', delta: metricDelta(tokens24h, Math.max(totalTokens - tokens24h, 0)) },
    { label: '对话数', value: formatNumber(totalConversations), size: 'lg', delta: metricDelta(conversations24h, Math.max(totalConversations - conversations24h, 0)) },
    { label: '用户数', value: formatNumber(totalUsers), size: 'lg', delta: metricDelta(activeUsers, Math.max(totalUsers - activeUsers, 0)) },
    { label: '24h Token', value: formatTokens(tokens24h), size: 'sm', delta: metricDelta(tokens24h, totalTokens || 1) },
    { label: '24h 对话', value: formatNumber(conversations24h), size: 'sm', delta: metricDelta(conversations24h, totalConversations || 1) },
    { label: '24h 消息', value: formatNumber(messages24h), size: 'sm', delta: metricDelta(messages24h, totalMessages || 1) },
    { label: '消息总数', value: formatNumber(totalMessages), size: 'sm', delta: metricDelta(messages24h, Math.max(totalMessages - messages24h, 0)) },
    { label: '管理员', value: formatNumber(totals.admins || 0), size: 'sm', delta: { text: '角色结构', cls: 'neutral' } },
    { label: '活跃用户(7d)', value: formatNumber(activeUsers), size: 'sm', delta: metricDelta(activeUsers, Math.max(totalUsers - activeUsers, 0)) },
    { label: '平均轮数', value: formatNumber(totals.avg_messages_per_conversation || 0), size: 'sm', delta: { text: '质量指标', cls: 'neutral' } },
    { label: '平均回复 Token', value: formatNumber(totals.avg_tokens_per_assistant_message || 0), size: 'sm', delta: { text: '质量指标', cls: 'neutral' } },
    { label: '模型数', value: formatNumber(totals.models_used || 0), size: 'sm', delta: { text: '覆盖范围', cls: 'neutral' } },
  ]

  refs.stats.innerHTML = stats.map((item) => `
    <div class="stat-card ${item.size === 'lg' ? 'is-lg' : ''}">
      <div class="stat-head">
        <div class="stat-label">${escHtml(item.label)}</div>
        <div class="stat-delta ${escAttr(item.delta.cls)}">${escHtml(item.delta.text)}</div>
      </div>
      <div class="stat-value">${escHtml(item.value)}</div>
    </div>
  `).join('')

  refs.recentUsers.innerHTML = adminDashboard?.recentUsers?.length
    ? adminDashboard.recentUsers.map((user) => `
        <div class="data-row rich-row">
          <div class="row-main">
            ${avatarFromText(user.email || user.displayName || 'U')}
            <div>
              <div class="row-title">${escHtml(user.email)}${user.isAdmin ? ' · 管理员' : ''}</div>
              <div class="row-meta">${escHtml(user.displayName || '未设置显示名')} · ${user.conversationCount} 对话 · ${user.messageCount} 消息 · 最近登录 ${escHtml(formatDateTime(user.lastLoginAt))}</div>
            </div>
          </div>
        </div>
      `).join('')
    : empty('暂无用户数据')

  refs.recentConversations.innerHTML = adminDashboard?.recentConversations?.length
    ? adminDashboard.recentConversations.map((conversation) => `
        <div class="data-row rich-row expandable" data-conversation-id="${escAttr(conversation.id)}">
          <div class="row-main">
            ${avatarFromText(conversation.email || 'C')}
            <div>
              <div class="row-title">${escHtml(conversation.title || '新对话')}</div>
              <div class="row-meta">${escHtml(conversation.email)} · ${conversation.messageCount} 消息 · 更新于 ${escHtml(formatDateTime(conversation.updatedAt))}</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="secondary row-action-fade toggle-conversation-detail" type="button">${expandedConversationId === conversation.id ? '收起' : '展开'}</button>
          </div>
        </div>
      `).join('')
    : empty('暂无对话数据')

  for (const row of refs.recentConversations.querySelectorAll('.data-row[data-conversation-id]')) {
    const conversationId = row.dataset.conversationId
    const toggleBtn = row.querySelector('.toggle-conversation-detail')
    if (toggleBtn) {
      toggleBtn.onclick = (event) => {
        event.stopPropagation()
        toggleRecentConversationDetail(conversationId, row).catch(showError)
      }
    }
    row.onclick = () => toggleRecentConversationDetail(conversationId, row).catch(showError)
    if (expandedConversationId === conversationId) {
      renderConversationDetail(row, adminConversationDetails[conversationId] || null, true)
    }
  }

  renderTrendChart(adminDashboard?.trends || [])
  renderModelUsage(adminDashboard?.modelStats || [])
  renderTopUsers(adminDashboard?.topUsers || [])
  renderTopConversations(adminDashboard?.topConversations || [])
  renderModelTable(adminDashboard?.modelStats || [])
}

function renderTrendChart(items) {
  if (!items.length) {
    if (trendChartInstance) {
      trendChartInstance.destroy()
      trendChartInstance = null
    }
    refs.trendChart.innerHTML = empty('暂无趋势数据')
    return
  }
  if (!window.ApexCharts) {
    refs.trendChart.innerHTML = empty('图表库未加载')
    return
  }
  if (trendChartInstance) trendChartInstance.destroy()

  refs.trendChart.innerHTML = ''
  const categories = items.map((item) => item.day)
  const tokensSeries = items.map((item) => Number(item.tokens || 0))
  const messagesSeries = items.map((item) => Number(item.messages || 0))
  const conversationsSeries = items.map((item) => Number(item.conversations || 0))

  trendChartInstance = new ApexCharts(refs.trendChart, {
    chart: {
      type: 'area',
      height: 300,
      toolbar: { show: false },
      animations: { easing: 'easeinout', speed: 450 },
      fontFamily: 'Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
    },
    series: [
      { name: 'Token', type: 'area', data: tokensSeries },
      { name: '消息', type: 'column', data: messagesSeries },
      { name: '对话', type: 'line', data: conversationsSeries },
    ],
    colors: ['#4f46e5', '#2563eb', '#0ea5e9'],
    stroke: { width: [2.5, 0, 2], curve: 'smooth' },
    fill: {
      type: ['gradient', 'solid', 'solid'],
      gradient: {
        shadeIntensity: 0.4,
        opacityFrom: 0.34,
        opacityTo: 0.02,
        stops: [0, 100],
      },
    },
    xaxis: {
      categories,
      axisTicks: { show: false },
      axisBorder: { show: false },
      labels: { style: { colors: '#64748b' } },
    },
    yaxis: [
      {
        seriesName: 'Token',
        labels: { formatter: (v) => formatTokens(v), style: { colors: '#64748b' } },
      },
      {
        opposite: true,
        seriesName: '消息',
        labels: { formatter: (v) => formatNumber(Math.round(v)), style: { colors: '#64748b' } },
      },
    ],
    grid: { borderColor: '#e2e8f0', strokeDashArray: 4 },
    legend: { position: 'top', horizontalAlign: 'left' },
    dataLabels: { enabled: false },
    tooltip: {
      shared: true,
      intersect: false,
      y: {
        formatter: (v, ctx) => (
          ctx.seriesIndex === 0 ? `${formatTokens(v)} tokens` : `${formatNumber(Math.round(v))}`
        ),
      },
    },
  })
  trendChartInstance.render()
}

function renderModelUsage(items) {
  if (!items.length) {
    if (modelUsageChartInstance) {
      modelUsageChartInstance.destroy()
      modelUsageChartInstance = null
    }
    refs.modelUsage.innerHTML = empty('暂无模型数据')
    return
  }
  if (!window.ApexCharts) {
    refs.modelUsage.innerHTML = empty('图表库未加载')
    return
  }
  if (modelUsageChartInstance) modelUsageChartInstance.destroy()

  const top = items.slice(0, 6)
  const labels = top.map((item) => item.modelId || '未记录模型')
  const values = top.map((item) => Number(item.messageCount || 0))
  const totalCalls = values.reduce((sum, current) => sum + current, 0)
  refs.modelUsage.innerHTML = ''

  modelUsageChartInstance = new ApexCharts(refs.modelUsage, {
    chart: {
      type: 'donut',
      height: 300,
      fontFamily: 'Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
    },
    labels,
    series: values,
    colors: ['#2563eb', '#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#f97316'],
    dataLabels: { enabled: false },
    legend: {
      position: 'bottom',
      formatter: (seriesName, opts) => `${seriesName} · ${formatNumber(opts.w.globals.series[opts.seriesIndex])}`,
    },
    plotOptions: {
      pie: {
        donut: {
          size: '66%',
          labels: {
            show: true,
            name: { show: true, color: '#64748b' },
            value: { show: true, color: '#1e293b', fontWeight: 800 },
            total: {
              show: true,
              label: '总请求',
              formatter: () => formatNumber(totalCalls),
            },
          },
        },
      },
    },
    tooltip: { y: { formatter: (v) => `${formatNumber(v)} 次调用` } },
  })
  modelUsageChartInstance.render()
}

function renderTopUsers(items) {
  refs.topUsers.innerHTML = items.length
    ? items.map((item, index) => `
        <div class="data-row rich-row">
          <div class="row-main">
            ${avatarFromText(item.email || String(index + 1))}
            <div>
              <div class="row-title">#${escHtml(index + 1)} ${escHtml(item.email)}</div>
              <div class="row-meta">${formatNumber(item.messageCount)} 消息 · ${formatTokens(item.totalTokens)} tokens · ${formatNumber(item.conversationCount)} 对话</div>
            </div>
          </div>
        </div>
      `).join('')
    : empty('暂无用户排行')
}

function renderTopConversations(items) {
  refs.topConversations.innerHTML = items.length
    ? items.map((item) => `
        <div class="data-row rich-row">
          <div class="row-main">
            ${avatarFromText(item.email || 'C')}
            <div>
              <div class="row-title">${escHtml(item.title || '新对话')}</div>
              <div class="row-meta">${escHtml(item.email)} · ${formatNumber(item.messageCount)} 消息 · ${formatTokens(item.totalTokens)} tokens</div>
            </div>
          </div>
        </div>
      `).join('')
    : empty('暂无对话排行')
}

function renderModelTable(items) {
  refs.modelTable.innerHTML = items.length
    ? items.map((item) => `
        <div class="data-row">
          <div>
            <div class="row-title">${escHtml(item.modelId || '未记录模型')}</div>
            <div class="row-meta">调用 ${formatNumber(item.messageCount)} 次 · 总 tokens ${formatTokens(item.totalTokens)} · 平均每轮 ${formatNumber(item.avgTokens)} tokens · 错误 ${formatNumber(item.errorCount)}</div>
          </div>
        </div>
      `).join('')
    : empty('暂无模型明细')
}

async function loadAdminDashboard() {
  adminDashboard = await api('/api/admin/dashboard')
  const currentIds = new Set((adminDashboard?.recentConversations || []).map((item) => item.id))
  if (expandedConversationId && !currentIds.has(expandedConversationId)) expandedConversationId = ''
  renderAdminDashboard()
}

function clearAdminUserCreateForm() {
  $('admin-create-email').value = ''
  $('admin-create-display-name').value = ''
  $('admin-create-password').value = ''
  $('admin-create-is-admin').checked = false
}

function renderAdminSettings() {
  const chat = adminSettings?.chat || {}
  $('admin-context-message-limit').value = chat.contextMessageLimit || 20
}

async function loadAdminSettings() {
  const data = await api('/api/admin/settings')
  adminSettings = data.settings || {}
  renderAdminSettings()
}

function clearAdminProviderForm() {
  $('admin-provider-id').value = ''
  $('admin-provider-name').value = ''
  $('admin-provider-base-url').value = ''
  $('admin-provider-api-key').value = ''
  $('admin-provider-api-format').value = 'openai_chat_completions'
  $('admin-provider-default-model').value = ''
  $('admin-provider-default-model-select').innerHTML = '<option value="">-- 请先点击刷新加载模型 --</option>'
  $('admin-model-load-status').classList.add('hidden')
}

async function loadAdminProviderModels() {
  const providerId = $('admin-provider-id').value.trim()
  const baseUrl = $('admin-provider-base-url').value.trim()
  const statusEl = $('admin-model-load-status')
  const selectEl = $('admin-provider-default-model-select')
  const inputEl = $('admin-provider-default-model')
  const btn = $('admin-load-models-btn')
  if (!baseUrl) {
    statusEl.textContent = '请先填写 Base URL'
    statusEl.classList.remove('hidden')
    return
  }
  btn.disabled = true
  btn.textContent = '加载中'
  statusEl.textContent = ''
  statusEl.classList.add('hidden')
  try {
    let models = []
    if (providerId) {
      const data = await api(`/api/admin/providers/${providerId}/models`)
      models = data.models || []
    } else {
      const apiKey = $('admin-provider-api-key').value.trim()
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      let resp = await fetch(baseUrl.replace(/\/$/, '') + '/v1/models', { headers })
      if (!resp.ok) resp = await fetch(baseUrl.replace(/\/$/, '') + '/models', { headers })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      models = (json.data || json.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name || '')).filter(Boolean)
    }
    const currentVal = inputEl.value.trim()
    selectEl.innerHTML = '<option value="">-- 请选择模型 --</option>'
      + models.map((m) => `<option value="${escAttr(m)}"${m === currentVal ? ' selected' : ''}>${escHtml(m)}</option>`).join('')
    statusEl.textContent = models.length ? `已加载 ${models.length} 个模型` : '未获取到模型列表'
    statusEl.classList.remove('hidden')
  } catch (err) {
    statusEl.textContent = `加载失败：${err.message}（可手动输入）`
    statusEl.classList.remove('hidden')
  } finally {
    btn.disabled = false
    btn.textContent = '刷新'
  }
}

function renderAdminProviders() {
  refs.providerList.innerHTML = adminProviders.length ? '' : empty('暂无全局 Provider')
  for (const provider of adminProviders) {
    const row = document.createElement('div')
    row.className = 'data-row'
    row.innerHTML = `
      <div>
        <div class="row-title">${escHtml(provider.name)}</div>
        <div class="row-meta">${escHtml(provider.baseUrl)} · ${escHtml(provider.apiFormat || 'openai_chat_completions')}${provider.defaultModel ? ' · ' + escHtml(provider.defaultModel) : ''}${provider.hasApiKey ? ' · 已配置 Key' : ''}</div>
      </div>
      <div class="row-actions">
        <button class="secondary edit-provider" type="button">编辑</button>
        <button class="secondary danger delete-provider" type="button">删除</button>
      </div>`
    row.querySelector('.edit-provider').onclick = () => {
      $('admin-provider-id').value = provider.id
      $('admin-provider-name').value = provider.name || ''
      $('admin-provider-base-url').value = provider.baseUrl || ''
      $('admin-provider-api-key').value = ''
      $('admin-provider-api-format').value = provider.apiFormat || 'openai_chat_completions'
      $('admin-provider-default-model').value = provider.defaultModel || ''
      setTimeout(loadAdminProviderModels, 100)
    }
    row.querySelector('.delete-provider').onclick = async () => {
      if (!confirm(`删除全局 Provider「${provider.name}」？`)) return
      await api(`/api/admin/providers/${provider.id}`, { method: 'DELETE' })
      await loadAdminProviders()
    }
    refs.providerList.appendChild(row)
  }
}

async function loadAdminProviders() {
  const data = await api('/api/admin/providers')
  adminProviders = data.providers || []
  renderAdminProviders()
}

function renderAdminUsers() {
  refs.userList.innerHTML = adminUsers.length ? '' : empty('暂无用户')
  for (const user of adminUsers) {
    const row = document.createElement('div')
    row.className = 'data-row expandable'
    row.innerHTML = `
      <div>
        <div class="row-title">${escHtml(user.email)}${user.id === currentUser?.id ? ' · 当前账号' : ''}</div>
        <div class="row-meta">
          <div>${user.conversationCount} 对话 · ${user.messageCount} 消息 · 注册 ${escHtml(formatDateTime(user.createdAt))} · 最近登录 ${escHtml(formatDateTime(user.lastLoginAt))}</div>
          <div class="stack-fields">
            <input class="input user-email" value="${escAttr(user.email || '')}" placeholder="登录邮箱" />
            <input class="input user-name" value="${escAttr(user.displayName || '')}" placeholder="显示名" />
            <input class="input user-password" type="password" placeholder="新密码，留空则不修改" />
          </div>
        </div>
      </div>
      <div class="row-actions">
        <label class="check-row"><input type="checkbox" class="user-admin" ${user.isAdmin ? 'checked' : ''} ${user.id === currentUser?.id ? 'disabled' : ''} /> 管理员</label>
        <button class="secondary save-user" type="button">保存</button>
        <button class="secondary danger delete-user" type="button" ${user.id === currentUser?.id ? 'disabled' : ''}>删除</button>
      </div>`
    row.querySelector('.save-user').onclick = async () => {
      const password = row.querySelector('.user-password').value
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          email: row.querySelector('.user-email').value,
          displayName: row.querySelector('.user-name').value,
          password,
          isAdmin: row.querySelector('.user-admin').checked,
        }),
      })
      row.querySelector('.user-password').value = ''
      await Promise.all([loadAdminUsers(), loadAdminDashboard()])
    }
    row.querySelector('.delete-user').onclick = async () => {
      if (!confirm(`删除用户「${user.email}」及其所有数据？`)) return
      await api(`/api/admin/users/${user.id}`, { method: 'DELETE' })
      await Promise.all([loadAdminUsers(), loadAdminDashboard()])
    }
    refs.userList.appendChild(row)
  }
}

async function loadAdminUsers() {
  const q = $('admin-user-search').value.trim()
  const data = await api(`/api/admin/users?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`)
  adminUsers = data.users || []
  renderAdminUsers()
}

function renderConversationDetail(row, detail, expanded) {
  row.classList.toggle('expanded', expanded)
  const btn = row.querySelector('.toggle-conversation-detail')
  if (btn) btn.textContent = expanded ? '收起' : '展开'
  const existing = row.querySelector('.conversation-detail')
  if (!expanded) {
    if (existing) existing.remove()
    return
  }
  if (!detail) {
    if (!existing) {
      const loading = document.createElement('div')
      loading.className = 'conversation-detail'
      loading.innerHTML = '<div class="row-meta">正在加载对话详情...</div>'
      row.appendChild(loading)
    }
    return
  }
  const detailHtml = `
    <div class="conversation-detail">
      <div class="conversation-summary">
        <span>${escHtml(detail.conversation.email)}</span>
        <span>${formatNumber(detail.conversation.messageCount)} 消息</span>
        <span>${formatTokens(detail.conversation.totalTokens)} tokens</span>
        <span>创建于 ${escHtml(formatDateTime(detail.conversation.createdAt))}</span>
        <span>更新于 ${escHtml(formatDateTime(detail.conversation.updatedAt))}</span>
      </div>
      <div class="message-timeline">
        ${detail.messages.length ? detail.messages.map((message) => `
          <div class="message-card">
            <div class="message-head">
              <div class="message-role">${escHtml(message.role)}</div>
              <div class="message-meta">${escHtml(formatDateTime(message.createdAt))}${message.tokenCount ? ` · ${formatTokens(message.tokenCount)} tokens` : ''}</div>
            </div>
            <div class="message-content">${escHtml(message.content || '(空消息)')}</div>
            ${message.error ? `<div class="message-error">${escHtml(message.error)}</div>` : ''}
          </div>
        `).join('') : '<div class="row-meta">暂无消息</div>'}
      </div>
    </div>
  `
  if (existing) {
    existing.outerHTML = detailHtml
  } else {
    row.insertAdjacentHTML('beforeend', detailHtml)
  }
}

async function toggleRecentConversationDetail(conversationId, row) {
  if (expandedConversationId === conversationId) {
    expandedConversationId = ''
    renderConversationDetail(row, null, false)
    return
  }

  const previousId = expandedConversationId
  expandedConversationId = conversationId
  if (previousId) {
    const previousRow = refs.recentConversations.querySelector(`[data-conversation-id="${CSS.escape(previousId)}"]`)
    if (previousRow) renderConversationDetail(previousRow, null, false)
  }

  renderConversationDetail(row, adminConversationDetails[conversationId] || null, true)
  if (!adminConversationDetails[conversationId]) {
    const data = await api(`/api/admin/conversations/${conversationId}`)
    adminConversationDetails[conversationId] = data
  }
  renderConversationDetail(row, adminConversationDetails[conversationId], true)
}

function clearAdminSkillForm() {
  $('admin-skill-id').value = ''
  $('admin-skill-clawhub-slug').value = ''
  $('admin-skill-icon').value = '🤖'
  $('admin-skill-name').value = ''
  $('admin-skill-desc').value = ''
  $('admin-skill-prompt').value = ''
  $('admin-skill-order').value = '0'
  $('admin-skill-active').checked = true
  $('admin-skill-default').checked = false
  $('clawhub-attachment-preview').classList.add('hidden')
  $('clawhub-attachment-preview').textContent = ''
}

function renderAttachmentPreview(files = []) {
  const preview = $('clawhub-attachment-preview')
  if (!files.length) {
    preview.classList.add('hidden')
    preview.textContent = ''
    return
  }
  const shown = files.slice(0, 3).join(', ')
  const extra = files.length > 3 ? `, +${files.length - 3} 个` : ''
  preview.textContent = `附带 ${files.length} 个附件文件：${shown}${extra}`
  preview.classList.remove('hidden')
}

async function toggleAdminSkillFiles(skill, row) {
  const existing = row.querySelector('.skill-files-list')
  if (existing) {
    existing.remove()
    return
  }
  const list = document.createElement('div')
  list.className = 'skill-files-list'
  list.innerHTML = '<div class="row-meta">正在加载附件...</div>'
  row.appendChild(list)
  try {
    if (!adminSkillFiles[skill.id]) {
      const data = await api(`/api/admin/skills/${skill.id}/files`)
      adminSkillFiles[skill.id] = data.files || []
    }
    const files = adminSkillFiles[skill.id]
    list.innerHTML = files.length
      ? files.map((file) => `
          <div class="skill-file-item">
            <span class="skill-file-path" title="${escAttr(file.relative_path)}">${escHtml(file.relative_path)}</span>
            <span>${escHtml(formatBytes(file.file_size))}</span>
          </div>
        `).join('')
      : '<div class="row-meta">暂无附件文件</div>'
  } catch (err) {
    list.innerHTML = `<div class="row-meta danger">附件加载失败：${escHtml(err.message)}</div>`
  }
}

function renderAdminSkillList() {
  refs.skillList.innerHTML = adminSkills.length ? '' : empty('暂无 Skill')
  for (const skill of adminSkills) {
    const row = document.createElement('div')
    row.className = 'data-row'
    row.innerHTML = `
      <div>
        <div class="row-title">${escHtml(skill.icon || '🤖')} ${escHtml(skill.name)}${skill.is_default ? ' · 默认' : ''}</div>
        <div class="row-meta">${skill.is_active ? '已启用' : '已停用'} · 排序 ${escHtml(skill.sort_order ?? 0)}${skill.description ? ' · ' + escHtml(skill.description) : ''}</div>
      </div>
      <div class="row-actions">
        ${skill.files_count > 0 ? `<button class="secondary files-skill" type="button">附件 ${escHtml(skill.files_count)}</button>` : ''}
        <button class="secondary edit-skill" type="button">编辑</button>
        <button class="secondary danger delete-skill" type="button">删除</button>
      </div>`
    const filesBtn = row.querySelector('.files-skill')
    if (filesBtn) filesBtn.onclick = () => toggleAdminSkillFiles(skill, row)
    row.querySelector('.edit-skill').onclick = () => {
      $('admin-skill-id').value = skill.id
      $('admin-skill-clawhub-slug').value = ''
      renderAttachmentPreview([])
      $('admin-skill-icon').value = skill.icon || '🤖'
      $('admin-skill-name').value = skill.name || ''
      $('admin-skill-desc').value = skill.description || ''
      $('admin-skill-prompt').value = skill.system_prompt || ''
      $('admin-skill-order').value = skill.sort_order ?? 0
      $('admin-skill-active').checked = Boolean(skill.is_active)
      $('admin-skill-default').checked = Boolean(skill.is_default)
    }
    row.querySelector('.delete-skill').onclick = async () => {
      if (!confirm(`删除 Skill「${skill.name}」？`)) return
      await api(`/api/admin/skills/${skill.id}`, { method: 'DELETE' })
      await loadAdminSkills()
    }
    refs.skillList.appendChild(row)
  }
}

async function loadAdminSkills() {
  const data = await api('/api/admin/skills')
  adminSkills = data.skills || []
  adminSkillFiles = {}
  renderAdminSkillList()
}

async function clawHubSearch(q) {
  const btn = $('clawhub-search-btn')
  const resultsEl = $('clawhub-results')
  btn.disabled = true
  btn.textContent = '搜索中'
  resultsEl.innerHTML = '<div class="row-meta">正在搜索...</div>'
  resultsEl.classList.remove('hidden')
  try {
    const data = await api(`/api/admin/skills/clawhub/search?q=${encodeURIComponent(q)}`)
    if (!data.results?.length) {
      resultsEl.innerHTML = '<div class="row-meta">无结果</div>'
      return
    }
    resultsEl.innerHTML = ''
    for (const item of data.results) {
      const div = document.createElement('div')
      div.className = 'clawhub-result-item'
      div.innerHTML = `
        <span class="clawhub-result-slug">${escHtml(item.slug)}</span>
        <span class="clawhub-result-desc">${escHtml(item.description || '')}</span>
        <button class="secondary import-skill" data-slug="${escAttr(item.slug)}" type="button">导入</button>
      `
      div.querySelector('.import-skill').onclick = async (e) => clawHubImport(e.target.dataset.slug)
      resultsEl.appendChild(div)
    }
  } catch (err) {
    resultsEl.innerHTML = `<div class="row-meta danger">搜索失败：${escHtml(err.message)}</div>`
  } finally {
    btn.disabled = false
    btn.textContent = '搜索'
  }
}

async function clawHubImport(slug) {
  const data = await api(`/api/admin/skills/clawhub/preview?slug=${encodeURIComponent(slug)}`)
  $('admin-skill-id').value = ''
  $('admin-skill-clawhub-slug').value = slug
  $('admin-skill-icon').value = '⚡'
  $('admin-skill-name').value = data.name || slug
  $('admin-skill-desc').value = data.description || ''
  $('admin-skill-prompt').value = data.system_prompt || ''
  $('admin-skill-order').value = '0'
  $('admin-skill-active').checked = true
  $('admin-skill-default').checked = false
  renderAttachmentPreview(data.attachmentFiles || [])
  $('clawhub-results').classList.add('hidden')
  $('admin-skill-form').scrollIntoView({ behavior: 'smooth' })
}

async function init() {
  if (!authToken) {
    location.href = '/'
    return
  }
  try {
    const data = await api('/api/auth/me')
    currentUser = data.user
    if (!currentUser?.isAdmin) {
      location.href = '/'
      return
    }
    refs.userLine.textContent = currentUser.email
    await Promise.all([loadAdminDashboard(), loadAdminProviders(), loadAdminSkills(), loadAdminSettings(), loadAdminUsers()])
    setTab('dashboard')
  } catch {
    LS.del('authToken')
    location.href = '/'
  }
}

for (const btn of document.querySelectorAll('.nav-btn')) btn.onclick = () => setTab(btn.dataset.tab)

$('admin-provider-reset').onclick = clearAdminProviderForm
$('admin-load-models-btn').onclick = loadAdminProviderModels
$('admin-provider-default-model-select').onchange = function() {
  if (this.value) $('admin-provider-default-model').value = this.value
}
$('admin-provider-default-model').oninput = function() {
  const select = $('admin-provider-default-model-select')
  const opt = [...select.options].find((item) => item.value === this.value)
  select.value = opt ? this.value : ''
}
refs.providerForm.onsubmit = async (event) => {
  event.preventDefault()
  const id = $('admin-provider-id').value
  const body = {
    name: $('admin-provider-name').value.trim(),
    baseUrl: $('admin-provider-base-url').value.trim(),
    apiFormat: $('admin-provider-api-format').value,
    defaultModel: $('admin-provider-default-model').value.trim(),
  }
  const apiKey = $('admin-provider-api-key').value.trim()
  if (apiKey || !id) body.apiKey = apiKey
  await api(id ? `/api/admin/providers/${id}` : '/api/admin/providers', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  })
  clearAdminProviderForm()
  await loadAdminProviders()
}

$('admin-skill-reset').onclick = clearAdminSkillForm
refs.skillForm.onsubmit = async (event) => {
  event.preventDefault()
  const id = $('admin-skill-id').value
  const body = {
    icon: $('admin-skill-icon').value.trim() || '🤖',
    name: $('admin-skill-name').value.trim(),
    description: $('admin-skill-desc').value.trim(),
    system_prompt: $('admin-skill-prompt').value.trim(),
    sort_order: Number.parseInt($('admin-skill-order').value, 10) || 0,
    is_active: $('admin-skill-active').checked,
    is_default: $('admin-skill-default').checked,
  }
  const clawhubSlug = $('admin-skill-clawhub-slug').value.trim()
  if (!id && clawhubSlug) body.clawhub_slug = clawhubSlug
  await api(id ? `/api/admin/skills/${id}` : '/api/admin/skills', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  })
  clearAdminSkillForm()
  await loadAdminSkills()
}

refs.settingsForm.onsubmit = async (event) => {
  event.preventDefault()
  const contextMessageLimit = Number.parseInt($('admin-context-message-limit').value, 10) || 20
  const data = await api('/api/admin/settings/chat', {
    method: 'PUT',
    body: JSON.stringify({ contextMessageLimit }),
  })
  adminSettings = { ...(adminSettings || {}), chat: data.setting.value }
  renderAdminSettings()
  setStatus('设置已保存')
}

$('clawhub-search-btn').onclick = () => {
  const q = $('clawhub-search-input').value.trim()
  if (q) clawHubSearch(q).catch(showError)
}
$('clawhub-search-input').onkeydown = (event) => {
  if (event.key === 'Enter') {
    const q = $('clawhub-search-input').value.trim()
    if (q) clawHubSearch(q).catch(showError)
  }
}
$('admin-user-search-btn').onclick = () => loadAdminUsers().catch(showError)
$('admin-user-search').onkeydown = (event) => {
  if (event.key === 'Enter') loadAdminUsers().catch(showError)
}
refs.userCreateForm.onsubmit = async (event) => {
  event.preventDefault()
  await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: $('admin-create-email').value.trim(),
      displayName: $('admin-create-display-name').value.trim(),
      password: $('admin-create-password').value,
      isAdmin: $('admin-create-is-admin').checked,
    }),
  })
  clearAdminUserCreateForm()
  await Promise.all([loadAdminUsers(), loadAdminDashboard()])
  setStatus('用户已创建')
}
$('logout-btn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }) } catch {}
  LS.del('authToken')
  LS.del('activeConversationId')
  location.href = '/'
}

init()
