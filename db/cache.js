import { createClient } from 'redis'

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'lite-chat'
const REDIS_READ_TIMEOUT_MS = Number.parseInt(process.env.REDIS_READ_TIMEOUT_MS || '30', 10)

let client
let connectPromise
let disabled = false
const memoryCache = new Map()

function key(name) {
  return `${KEY_PREFIX}:${name}`
}

function getMemory(name) {
  const entry = memoryCache.get(name)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(name)
    return null
  }
  return entry.value
}

function setMemory(name, value, ttlSeconds) {
  memoryCache.set(name, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
}

function patternToRegExp(pattern) {
  return new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

async function getClient() {
  if (disabled) return null
  if (client?.isOpen) return client
  if (!client) {
    client = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 250,
        reconnectStrategy: false,
      },
    })
    client.on('error', (err) => {
      disabled = true
      console.error('[redis] disabled:', err.message)
    })
  }
  connectPromise ||= client.connect().catch((err) => {
    disabled = true
    console.error('[redis] connect failed:', err.message)
    return null
  })
  await connectPromise
  return client?.isOpen ? client : null
}

export async function cacheGetJson(name) {
  try {
    const cached = getMemory(name)
    if (cached) return cached
    const redis = await getClient()
    if (!redis) return null
    const value = await Promise.race([
      redis.get(key(name)),
      new Promise((resolve) => setTimeout(() => resolve(null), REDIS_READ_TIMEOUT_MS)),
    ])
    if (!value) return null
    const parsed = JSON.parse(value)
    setMemory(name, parsed, 30)
    return parsed
  } catch {
    return null
  }
}

export async function cacheSetJson(name, value, ttlSeconds = 30) {
  setMemory(name, value, ttlSeconds)
  try {
    getClient().then((redis) => {
      if (!redis) return
      return redis.set(key(name), JSON.stringify(value), { EX: ttlSeconds })
    }).catch(() => {})
  } catch {}
}

export async function cacheGetNumber(name, fallback = 0) {
  const fromMemory = getMemory(name)
  if (typeof fromMemory === 'number' && Number.isFinite(fromMemory)) return fromMemory
  try {
    const redis = await getClient()
    if (!redis) return fallback
    const value = await Promise.race([
      redis.get(key(name)),
      new Promise((resolve) => setTimeout(() => resolve(null), REDIS_READ_TIMEOUT_MS)),
    ])
    if (value === null || value === undefined) return fallback
    const parsed = Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed)) return fallback
    setMemory(name, parsed, 30)
    return parsed
  } catch {
    return fallback
  }
}

export async function cacheIncr(name, ttlSeconds = 86400) {
  const current = await cacheGetNumber(name, 0)
  const next = current + 1
  setMemory(name, next, Math.max(30, Math.min(ttlSeconds, 86400)))
  try {
    getClient().then(async (redis) => {
      if (!redis) return
      const nextValue = await redis.incr(key(name))
      if (ttlSeconds > 0) await redis.expire(key(name), ttlSeconds)
      setMemory(name, nextValue, Math.max(30, Math.min(ttlSeconds, 86400)))
    }).catch(() => {})
  } catch {}
  return next
}

export async function cacheDel(...names) {
  for (const name of names) memoryCache.delete(name)
  try {
    getClient().then(async (redis) => {
      if (!redis || !names.length) return
      await redis.del(names.map(key))
    }).catch(() => {})
  } catch {}
}

export async function cacheDelPattern(pattern) {
  const matcher = patternToRegExp(pattern)
  for (const name of memoryCache.keys()) {
    if (matcher.test(name)) memoryCache.delete(name)
  }
  try {
    getClient().then(async (redis) => {
      if (!redis) return
      const stream = redis.scanIterator({ MATCH: key(pattern), COUNT: 100 })
      const keys = []
      for await (const found of stream) {
        if (Array.isArray(found)) keys.push(...found)
        else keys.push(found)
        if (keys.length >= 100) {
          await redis.del(keys.splice(0))
        }
      }
      if (keys.length) await redis.del(keys)
    }).catch(() => {})
  } catch {}
}

export async function closeCache() {
  if (client?.isOpen) await client.quit()
}
