import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkStaticRoutes } from './lib/static-check.mjs'
import { createSharedSaves, SaveSlotError } from './lib/shared-saves.mjs'

const port = Number(process.env.PORT) || 18769
// 默认只绑本机。存档是明文 JSON，绑 0.0.0.0 等于把整台机器的故事和存档摊给同一 Wi-Fi 的
// 所有人——不需要任何密码就能读。要手机连，显式加 --lan（或设 STORY_LAN=1）。
const lanEnabled = process.argv.includes('--lan') || process.env.STORY_LAN === '1'
const bindHost = lanEnabled ? '0.0.0.0' : '127.0.0.1'
const host = '127.0.0.1'
const url = 'http://' + host + ':' + port + '/'
const sharedSaves = createSharedSaves(fileURLToPath(new URL('./data/shared-saves/', import.meta.url)))

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/theme.js', ['theme.js', 'text/javascript']],
  ['/chat.js', ['chat.js', 'text/javascript']],
  ['/credentials.js', ['credentials.js', 'text/javascript']],
  ['/compiler.mjs', ['compiler.mjs', 'text/javascript']],
  ['/lib/choices.mjs', ['lib/choices.mjs', 'text/javascript']],
  ['/lib/context.mjs', ['lib/context.mjs', 'text/javascript']],
  ['/lib/roster.mjs', ['lib/roster.mjs', 'text/javascript']],
  ['/lib/save-slots.mjs', ['lib/save-slots.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/chat.css', ['chat.css', 'text/css']]
])

// ---------- 模型凭据：服务端一律不持有 ----------
//
// 这里刻意不读任何本机凭据：不读环境变量、不读 ~/.dsh、不读 .env、不扫盘。
// 程序启动后不会主动去找 key，也不会因为找不到而失败——它只在你按下发送时，
// 把浏览器里那份 key 原样转给上游。
//
// 谁持有：玩家自己的浏览器（localStorage，仅这台设备）。
// 服务端只做一件事：把 Authorization 和 x-model-endpoint 两个请求头转发出去，用完即弃。
// 因此换台机器、换个浏览器，都需要重新填一次——这是设计，不是缺陷。

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

// 只接受 http(s) 绝对地址，挡住 file: / 无协议 / 空值。
function resolveEndpoint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return DEFAULT_ENDPOINT
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return parsed.toString()
}

// DeepSeek 的这个字段别的家不认，只对自家端点带上。
function isDeepSeekEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname.endsWith('deepseek.com')
  } catch {
    return false
  }
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
  // 凭据只从这一条请求里来：浏览器带上来的 Authorization 头。
  // 服务端不缓存、不落盘、不读本机任何文件；请求结束即丢。
  const authorization = request.headers.authorization || ''
  const apiKey = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!apiKey) {
    return json(response, 401, {
      error: '没有 API Key。点右上角 ⚙ 打开设置，把 key 填进去——它只存在你自己的浏览器里。'
    })
  }

  const endpoint = resolveEndpoint(request.headers['x-model-endpoint'])
  if (!endpoint) {
    return json(response, 400, { error: 'API 地址无效，需要 http:// 或 https:// 开头的完整地址。' })
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

  const upstreamBody = { model, messages, max_tokens: maxTokens, stream: true }
  if (isDeepSeekEndpoint(endpoint)) upstreamBody.effort = 'low'

  let upstream
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody)
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
  // Host 白名单：没开 --lan 时只认本机；开了才放行私有网段（外部域名照样进不来，
  // DNS rebinding 仍然挡得住）。100.64/10 给 Tailscale 留着。
  const privateHost = lanEnabled
    ? /^(?:127\.0\.0\.1|localhost|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?::\d+)?$/i
    : /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i
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
    return json(response, 200, { ok: true })
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

// 默认只监听 127.0.0.1。--lan 才绑 0.0.0.0（手机同 Wi-Fi 连进来用）。
server.listen(port, bindHost, async () => {
  console.log('角色剧本卡片编辑器 + 对话 ' + url)
  if (!lanEnabled) {
    console.log('只监听本机。手机要走局域网的话，加 --lan 重启（同 Wi-Fi 的人将能打开这个页面、读到存档）')
  } else {
    const lan = Object.values(networkInterfaces()).flat()
      .find(item => item && item.family === 'IPv4' && !item.internal)?.address
    if (lan) console.log('手机（同一 Wi-Fi）→ http://' + lan + ':' + port + '/')
    console.log('⚠ 局域网已开：同一 Wi-Fi 下的任何人都能打开上面这个地址、读你的存档。不用时请关掉。')
  }
  console.log('模型通道：由浏览器填入（服务端不读取任何本机凭据）')
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



