import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import 'dotenv/config'

const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || process.env.API_PORT || 3001)
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const dataFile = path.join(dataDirectory, 'taskflow.json')
const isProduction = process.env.NODE_ENV === 'production'
const sessionMaxAge = 7 * 24 * 60 * 60 * 1000
const cookieName = 'taskflow_session'
const app = express()
const rateLimits = new Map()
const liveClients = new Map()
let persistQueue = Promise.resolve()
let store = { users: [], sessions: [] }

await fs.mkdir(dataDirectory, { recursive: true })
try {
  store = JSON.parse(await fs.readFile(dataFile, 'utf8'))
  store.users ??= []
  store.sessions ??= []
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

function saveStore() {
  persistQueue = persistQueue.then(async () => {
    const temporaryFile = `${dataFile}.tmp`
    await fs.writeFile(temporaryFile, JSON.stringify(store), { mode: 0o600 })
    await fs.rename(temporaryFile, dataFile)
  })
  return persistQueue
}

function safeUser(user) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt }
}

function rateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`
  const now = Date.now()
  const entry = rateLimits.get(key) ?? { count: 0, resetAt: now + 10 * 60 * 1000 }
  if (entry.resetAt < now) {
    entry.count = 0
    entry.resetAt = now + 10 * 60 * 1000
  }
  entry.count += 1
  rateLimits.set(key, entry)
  if (entry.count > 12) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' })
  return next()
}

function verifySameOrigin(req, res, next) {
  const origin = req.get('origin')
  const host = req.get('x-forwarded-host') || req.get('host')
  if (origin && origin !== `${req.protocol}://${host}`) {
    return res.status(403).json({ error: 'Request origin was not allowed.' })
  }
  return next()
}

function getSession(req) {
  const token = req.cookies?.[cookieName]
  if (!token) return null
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const session = store.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now())
  return session ? store.users.find((user) => user.id === session.userId) ?? null : null
}

function requireUser(req, res, next) {
  const user = getSession(req)
  if (!user) return res.status(401).json({ error: 'Please sign in to continue.' })
  req.user = user
  return next()
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' })
  return next()
}

function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('base64url')
  store.sessions = store.sessions.filter((item) => item.expiresAt > Date.now())
  store.sessions.push({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId: user.id,
    expiresAt: Date.now() + sessionMaxAge,
  })
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionMaxAge,
  })
}

function broadcastWorkspace(userId, data) {
  const clients = liveClients.get(userId)
  if (!clients) return
  const message = `event: workspace\ndata: ${JSON.stringify(data)}\n\n`
  clients.forEach((client) => client.write(message))
}

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  })
  next()
})
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '10kb' }))
app.use((req, res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((part) => {
    const separator = part.indexOf('=')
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]
  }))
  req.cookies = cookies
  next()
})

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

app.post('/api/auth/signup', verifySameOrigin, rateLimit, async (req, res, next) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase()
    const password = String(req.body.password ?? '')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' })
    if (store.users.some((user) => user.email === email)) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' })
    const salt = crypto.randomBytes(16).toString('hex')
    const passwordHash = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (error, derivedKey) => error ? reject(error) : resolve(derivedKey.toString('hex')))
    })
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash,
      salt,
      role: email === String(process.env.TASKFLOW_ADMIN_EMAIL ?? '').trim().toLowerCase() ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
      workspace: null,
    }
    store.users.push(user)
    createSession(res, user)
    await saveStore()
    return res.status(201).json({ user: safeUser(user) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/login', verifySameOrigin, rateLimit, async (req, res, next) => {
  try {
    const email = String(req.body.email ?? '').trim().toLowerCase()
    const password = String(req.body.password ?? '')
    const user = store.users.find((item) => item.email === email)
    if (!user || password.length > 128) return res.status(401).json({ error: 'Email or password is incorrect.' })
    const candidate = await new Promise((resolve, reject) => {
      crypto.scrypt(password, user.salt, 64, (error, derivedKey) => error ? reject(error) : resolve(derivedKey))
    })
    if (!crypto.timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' })
    }
    createSession(res, user)
    await saveStore()
    return res.json({ user: safeUser(user) })
  } catch (error) {
    return next(error)
  }
})

app.post('/api/auth/logout', verifySameOrigin, requireUser, async (req, res, next) => {
  try {
    const token = req.cookies[cookieName]
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash)
    await saveStore()
    res.clearCookie(cookieName, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' })
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/auth/me', (req, res) => {
  const user = getSession(req)
  if (!user) return res.status(401).json({ error: 'Not signed in.' })
  return res.json({ user: safeUser(user) })
})

app.get('/api/workspace', requireUser, (req, res) => {
  res.json({ data: req.user.workspace })
})

app.put('/api/workspace', verifySameOrigin, requireUser, async (req, res, next) => {
  try {
    if (!req.body.data || typeof req.body.data !== 'object' || Array.isArray(req.body.data)) {
      return res.status(400).json({ error: 'Workspace data must be an object.' })
    }
    const serialized = JSON.stringify(req.body.data)
    if (serialized.length > 900_000) return res.status(413).json({ error: 'Workspace is too large to save.' })
    const changed = JSON.stringify(req.user.workspace) !== serialized
    req.user.workspace = req.body.data
    await saveStore()
    if (changed) broadcastWorkspace(req.user.id, req.user.workspace)
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

app.get('/api/workspace/events', requireUser, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.flushHeaders()
  const clients = liveClients.get(req.user.id) ?? new Set()
  clients.add(res)
  liveClients.set(req.user.id, clients)
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
    if (clients.size === 0) liveClients.delete(req.user.id)
  })
})

app.get('/api/admin/users', requireUser, requireAdmin, (_req, res) => {
  res.json({ users: store.users.map(safeUser).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
})

app.patch('/api/admin/users/:id/role', verifySameOrigin, requireUser, requireAdmin, async (req, res, next) => {
  try {
    const user = store.users.find((item) => item.id === req.params.id)
    const nextRole = req.body.role
    if (!user) return res.status(404).json({ error: 'Account not found.' })
    if (!['admin', 'user'].includes(nextRole)) return res.status(400).json({ error: 'Role must be admin or user.' })
    if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' })
    if (user.role === 'admin' && nextRole === 'user' && store.users.filter((item) => item.role === 'admin').length === 1) {
      return res.status(400).json({ error: 'The last admin cannot be changed to a regular user.' })
    }
    user.role = nextRole
    await saveStore()
    return res.json({ user: safeUser(user) })
  } catch (error) {
    return next(error)
  }
})

if (isProduction) {
  app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: '1h' }))
  app.get('*path', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))
}

app.use((error, _req, res, _next) => {
  console.error('API request failed.', error)
  res.status(500).json({ error: 'The server could not complete that request. Please try again.' })
})

app.listen(port, '0.0.0.0', () => {
  console.log(`TaskFlow server listening on port ${port}`)
})
