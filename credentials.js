// 玩家自己的模型凭据。
//
// 三条规矩：
//   1. 只存在这台设备的浏览器里（localStorage）。不写文件、不进仓库、不上报。
//   2. 服务端不读环境变量、不读 ~/.dsh、不扫盘找 sk- 开头的串——它只在转发
//      一次请求时用这个 key，用完即弃。启动时没有任何「自动获取」动作。
//   3. 换一台设备、换一个浏览器、清一次浏览器数据，就要重新填。这是代价，
//      也是它不会跟着仓库流传出去的原因。

const STORAGE_KEY = 'story-card-editor.credentials'

export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

const empty = () => ({ endpoint: '', key: '', model: '' })

export function readCredentials() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return empty()
    return {
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      key: typeof raw.key === 'string' ? raw.key : '',
      model: typeof raw.model === 'string' ? raw.model : ''
    }
  } catch {
    return empty()
  }
}

export function saveCredentials(patch) {
  const next = { ...readCredentials(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式或配额满：这次填的只在当前页面有效，刷新就没了。
  }
  return next
}

export function clearCredentials() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function effectiveEndpoint() {
  const { endpoint } = readCredentials()
  return endpoint.trim() || DEFAULT_ENDPOINT
}

// 给 UI 用的：把 key 折成 sk-ab…cdef，避免整串出现在屏幕上或被截图带走。
export function maskKey(key) {
  const text = String(key || '').trim()
  if (!text) return ''
  if (text.length <= 10) return text.slice(0, 2) + '…'
  return text.slice(0, 5) + '…' + text.slice(-4)
}
