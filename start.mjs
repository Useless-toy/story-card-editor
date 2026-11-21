import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkStaticRoutes } from './lib/static-check.mjs'
import { createSharedSaves, SaveSlotError } from './lib/shared-saves.mjs'

const port = 18769
const host = '127.0.0.1'
const url = 'http://' + host + ':' + port + '/'
const sharedSaves = createSharedSaves(fileURLToPath(new URL('./data/shared-saves/', import.meta.url)))

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/theme.js', ['theme.js', 'text/javascript']],
  ['/chat.js', ['chat.js', 'text/javascript']],
  ['/compiler.mjs', ['compiler.mjs', 'text/javascript']],
  ['/lib/choices.mjs', ['lib/choices.mjs', 'text/javascript']],
  ['/lib/context.mjs', ['lib/context.mjs', 'text/javascript']],
  ['/lib/roster.mjs', ['lib/roster.mjs', 'text/javascript']],
  ['/lib/save-slots.mjs', ['lib/save-slots.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/chat.css', ['chat.css', 'text/css']]
])

// ---------- API key ----------

let apiKey = null

async function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const candidates = [
    join(homedir(), '.dsh', '.credentials.yaml'),
    join(process.cwd(), '.deepseek-key')
  ]
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf8')
      const found = text.match(/sk-[A-Za-z0-9]{20,}/)
      if (found) return found[0]
    } catch {}
  }
  return null
}

// ---------- helpers ----------

async function readBody(request, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function handleSaveSlots(request, response, path) {
  const listPath = '/api/save-slots'
  const match = /^\/api\/save-slots\/(\d+)$/.exec(path)
  const slot = match ? Number(match[1]) : null
  try {
    if (request.method === 'GET' && path === listPath) return json(response, 200, await sharedSaves.list())
    if (slot === null) return json(response, 404, { error: '找不到存档槽位。' })
    if (request.method === 'GET') return json(response, 200, await sharedSaves.get(slot))
    if (request.method !== 'POST') return json(response, 405, { error: '不支持此存档操作。' })
    const { origin, host } = request.headers
    if ((origin && origin !== 'http://' + host) || request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: '请在游戏页面内操作存档。' })
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      return json(response, 415, { error: '存档操作须使用 JSON。' })
    }
    let payload
    try {
      payload = JSON.parse(await readBody(request, 32 * 1024 * 1024))
    } catch {
      return json(response, 400, { error: '存档数据无效或超过 32 MB。' })
    }
    await sharedSaves.change(slot, payload?.expected, payload?.operation)
    return json(response, 200, { ok: true })
  } catch (error) {
    if (error instanceof SaveSlotError) return json(response, error.status, { error: error.message })
    console.error('[共享存档]', error.code ?? error.name)
    return json(response, 500, { error: '共享存档读写失败，请检查服务端存档文件。' })
  }
}

// ---------- POST /api/chat ----------
// 请求：{ messages: [{role, content}], model?, maxTokens? }
// 响应：纯文本流。上游的 reasoning_content 已被丢弃，只转发正文。

async function handleChat(request, response) {
  if (!apiKey) {
    return json(response, 500, {
      error: '没有找到 DeepSeek API Key。设置环境变量 DEEPSEEK_API_KEY，或确认 ' + join(homedir(), '.dsh', '.credentials.yaml') + ' 里有 sk- 开头的 key。'
    })
  }

  let payload
  try {
    payload = JSON.parse(await readBody(request))
  } catch (error) {
    return json(response, 400, { error: '请求体不是合法 JSON：' + error.message })
  }

  const messages = payload?.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(response, 400, { error: 'messages 不能为空' })
  }
  for (const message of messages) {
    if (!message || typeof message.role !== 'string' || typeof message.content !== 'string') {
      return json(response, 400, { error: '每条消息都需要 role 和 content 两个字符串' })
    }
  }

  const model = typeof payload.model === 'string' && payload.model ? payload.model : 'deepseek-flash'
  const maxTokens = Number.isInteger(payload.maxTokens) && payload.maxTokens > 0 ? payload.maxTokens : 6000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)

  let upstream
  try {
    upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, effort: 'low', stream: true })
    })
  } catch (error) {
    clearTimeout(timer)
    return json(response, 502, { error: '连接模型失败：' + error.message })
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer)
    let detail = ''
    try { detail = (await upstream.text()).slice(0, 400) } catch {}
    return json(response, 502, { error: '模型返回 ' + upstream.status, detail })
  }

  response.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let emitted = 0
  let interrupted = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed?.choices?.[0]?.delta
          // 只转发正文；reasoning_content 是模型的内部推理，用户不该看到
          if (delta && typeof delta.content === 'string' && delta.content) {
            response.write(delta.content)
            emitted += delta.content.length
          }
        } catch {
          // 单行解析失败不影响整体流
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      interrupted = true
      try { response.write('\n\n[连接中断：' + error.message + ']') } catch {}
    }
  } finally {
    clearTimeout(timer)
    // 一个字都没转出去 = 上游只回了 reasoning（被上面的过滤丢掉），或直接空响应。
    // 不兜这一句，页面就是一个空气泡 + 状态栏永远停在「正在生成…」。
    if (!interrupted && emitted === 0) {
      try { response.write('[本轮没有返回正文] 上游只回了内部推理，过滤后为空。请重试一次。') } catch {}
    }
    try { response.end() } catch {}
  }
}

// ---------- server ----------

const server = createServer(async (request, response) => {
  const hostHeader = request.headers.host
  // 原来是一份死名单（127.0.0.1 / localhost）：手机用局域网 IP 进来会直接 403。
  // 放宽到私有网段——外部域名照样进不来（DNS rebinding 仍然挡得住），但 LAN 能通；
  // 100.64/10 顺带给 Tailscale 留着。
  const privateHost = /^(?:127\.0\.0\.1|localhost|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d+)?$/i
  if (!privateHost.test(hostHeader ?? '')) {
    return response.writeHead(403).end()
  }

  const path = (request.url ?? '/').split('?')[0]
  if (path === '/api/save-slots' || path.startsWith('/api/save-slots/')) {
    return handleSaveSlots(request, response, path)
  }

  if (path === '/api/chat') {
    if (request.method !== 'POST') {
      return response.writeHead(405, { Allow: 'POST' }).end()
    }
    return handleChat(request, response)
  }

  if (path === '/api/health') {
    return json(response, 200, { ok: true, hasKey: Boolean(apiKey) })
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    return response.writeHead(405, { Allow: 'GET, HEAD' }).end()
  }

  const asset = files.get(path) ?? (/^\/scripts\/[a-z0-9-]+\.json$/i.test(path) ? [path.slice(1), 'application/json'] : null)
  if (!asset) return response.writeHead(404).end()

  try {
    const body = await readFile(new URL('./' + asset[0], import.meta.url))
    response.writeHead(200, {
      'Content-Type': asset[1].startsWith('image/') ? asset[1] : asset[1] + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end()
  }
})

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '端口已占用。如果编辑器正在运行，请直接打开 ' + url : error.message)
  process.exitCode = 1
})

apiKey = await loadApiKey()

// 绑 0.0.0.0：手机（同一 Wi-Fi）要能从局域网进来；只绑 127.0.0.1 时外部连不上。
server.listen(port, '0.0.0.0', async () => {
  console.log('角色剧本卡片编辑器 + 对话 ' + url)
  const lan = Object.values(networkInterfaces()).flat()
    .find(item => item && item.family === 'IPv4' && !item.internal)?.address
  if (lan) console.log('手机（同一 Wi-Fi）→ http://' + lan + ':' + port + '/')
  console.log(apiKey ? '模型通道：已就绪（' + apiKey.slice(0, 10) + '…）' : '模型通道：缺少 API Key —— 对话功能不可用')
  const routeWarnings = await checkStaticRoutes(files, file => readFile(new URL('./' + file, import.meta.url), 'utf8'))
  for (const warning of routeWarnings) console.warn('[路由自检] ' + warning)
  if (process.argv.includes('--no-open')) return
  const commands = {
    win32: ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    darwin: ['open', [url]],
    linux: ['xdg-open', [url]]
  }
  const command = commands[process.platform]
  if (!command) return
  const browser = spawn(command[0], command[1], { stdio: 'ignore', detached: true, windowsHide: true })
  browser.on('error', () => console.log('请在浏览器手动打开 ' + url))
  browser.unref()
})



