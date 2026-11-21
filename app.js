import { compile, createDraft, customRequest, panelConfigOf, prismRequest, startLedger, validateRoutes, validateScript } from './compiler.mjs'
import { splitChoices } from './lib/choices.mjs'
import { DEFAULT_ENDPOINT, clearCredentials, maskKey, pushClear, pushCredentials, readCredentials, saveCredentials, serverHasKey } from './credentials.js'

const storageKey = 'story-card-editor.v1'
const el = id => document.getElementById(id)
const scripts = new Map()
const drafts = new Map()
const localIds = new Set()
const inputs = new Map()
let script
let draft
let editingRoute
const worldFields = ['place', 'duration', 'rule']

export const installedStoryScripts = () => scripts.values()
export const openingForPlay = () => compile(script, draft, { random: Math.random })

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function button(text, action, className) {
  const node = element('button', text, className)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

function remember() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      active: script.id,
      localScripts: [...localIds].map(id => scripts.get(id)),
      drafts: [...drafts.values()]
    }))
    el('notice').textContent = ''
  } catch {
    el('notice').textContent = '浏览器无法保存草稿。你可以导出 JSON 备份当前内容。'
  }
}

function detail(title, text) {
  el('detail-title').textContent = title
  el('detail-body').textContent = text
  el('detail').showModal()
}

function modelSelection() {
  const select = el('model')
  for (const option of [...select.options]) {
    if (option.dataset.custom) option.remove()
  }
  if (![...select.options].some(option => option.value === draft.selectedModel)) {
    const option = new Option(draft.selectedModel, draft.selectedModel)
    option.dataset.custom = 'true'
    select.add(option)
  }
  select.value = draft.selectedModel
}

function availableRoutes() {
  return draft.routes ?? script.routes
}

function worldText(setting) {
  return ['地点：' + setting.place, '时长：' + setting.duration, '规则：' + setting.rule].join('\n')
}

function update() {
  const route = availableRoutes().find(route => route.id === draft.routeId)
  el('custom-label').hidden = !route?.custom
  el('custom-caption').textContent = route?.random ? '随机开局提示（可选）' : '自由开场'
  el('custom').placeholder = route?.random ? '例如：希望开局偏舞台竞争或团员合作' : '从你想要的第一幕开始写'
  el('world-panel-text').textContent = worldText(draft.setting)
  el('copy-status').textContent = ''
  let error = ''
  try {
    const fullText = compile(script, draft)
    const request = script.turnPanels === 'prism'
      ? prismRequest([{ role:'user', content:fullText }], new Map(), script.prismStats ? startLedger(script.prismStats, script.fans ?? []) : null, {recent:[],archive:[],nextId:1})
      : customRequest([], new Map(), null, panelConfigOf(script), fullText)
    el('output').textContent = request[0].content
    {
      const note = document.querySelector('#opening-preview .muted')
      if (note) {
        const context = request.context
        note.textContent = context ? '以下是首轮实际发送的 system，' + context.total + '/' + context.budget.total + ' 字。'
          + [['resident','规则'],['roster','角色'],['worldBook','世界书'],['basis','基准']].map(([k,label])=>label+' '+context.sizes[k]+'/'+context.budget[k]).join(' · ')
          + (context.clipped.length ? '。已按预算裁剪：' + context.clipped.join('、') : '') : '首轮发送内容。'
      }
    }
    el('output').dataset.prismStats = script.turnPanels === 'prism' && script.prismStats ? JSON.stringify(script.prismStats) : ''
    el('output').dataset.prismFans = JSON.stringify(script.fans ?? [])
    el('output').dataset.scriptId = script.id
    el('output').dataset.player = JSON.stringify(draft.player)
  } catch (failure) {
    error = failure.message
    el('output').textContent = ''
  }
  el('world-error').textContent = error
  el('compile-error').textContent = error
  el('copy').disabled = Boolean(error)
  el('export').disabled = Boolean(error)
  remember()
}

function renderWorld() {
  for (const key of worldFields) el('world-' + key).value = draft.setting[key]
  el('world-panel-title').textContent = script.title
  el('world-panel').open = draft.panelOpen.world
  el('memory-panel').open = draft.panelOpen.memory
  el('memory-text').textContent = draft.summary?.text || '当前草稿暂无记忆摘要。'
}

function applyWorld() {
  draft.setting = { ...draft.setting, ...Object.fromEntries(worldFields.map(key => [key, el('world-' + key).value])) }
  update()
}

function renderFields() {
  inputs.clear()
  const fields = script.playerFields.map(field => {
    const input = element(field.type === 'textarea' ? 'textarea' : 'input')
    if (field.type === 'textarea') input.rows = 2
    else input.type = 'text'
    input.value = draft.player[field.key]
    input.addEventListener('input', () => {
      draft.player[field.key] = input.value
      update()
    })
    inputs.set(field.key, input)
    const label = element('label', field.label)
    label.append(input)
    const chips = element('div', undefined, 'chips')
    for (const preset of field.chips ?? []) chips.append(button(preset, () => {
      input.value = preset
      draft.player[field.key] = preset
      if (field.key === 'name' && script.playerPresets && Object.hasOwn(script.playerPresets, preset)) {
        const profile = script.playerPresets[preset]
        for (const { key } of script.playerFields) {
          if (typeof profile?.[key] !== 'string') continue
          draft.player[key] = profile[key]
          inputs.get(key).value = profile[key]
        }
      }
      update()
    }, 'chip'))
    const wrapper = element('div', undefined, 'field')
    wrapper.append(label, chips)
    return wrapper
  })
  el('fields').replaceChildren(...fields)
}

function renderRoutes() {
  const routes = el('routes')
  const presets = availableRoutes().length - 1
  for (const card of routes.querySelectorAll('.route-item')) card.remove()
  for (const route of availableRoutes()) {
    const radio = element('input')
    radio.type = 'radio'
    radio.name = 'route'
    radio.value = route.id
    radio.checked = route.id === draft.routeId
    radio.addEventListener('change', () => {
      draft.routeId = route.id
      update()
    })
    const content = element('span')
    content.append(element('strong', (route.recommended ? '🔥 ' : '') + route.name),
      element('p', route.random ? '每次开局抽取场景和冲突，由模型写出新的第一幕。' : route.custom ? '写下你自己的第一幕。' : route.scene))
    const card = element('label', undefined, 'route')
    card.append(radio, content)
    const row = element('div', undefined, 'route-item')
    row.append(card)
    if (!route.custom) {
      const actions = element('div', undefined, 'route-actions')
      const edit = button('编辑', () => editRoute(route))
      edit.setAttribute('aria-label', '编辑 ' + route.name)
      const remove = button('删除', () => deleteRoute(route))
      remove.setAttribute('aria-label', '删除 ' + route.name)
      remove.disabled = presets === 1
      actions.append(edit, remove)
      row.append(actions)
    }
    routes.append(row)
  }
}

function deleteRoute(route) {
  if (availableRoutes().length <= 2 || !window.confirm('删除「' + route.name + '」？')) return
  draft.routes = validateRoutes(availableRoutes().filter(item => item.id !== route.id), script.roles)
  if (draft.routeId === route.id) draft.routeId = draft.routes[0].id
  renderRoutes()
  update()
}

function editRoute(route) {
  editingRoute = route
  el('route-editor-title').textContent = route ? '编辑路线' : '新增路线'
  el('route-name').value = route?.name ?? ''
  el('route-scene').value = route?.scene ?? ''
  el('route-error').textContent = ''
  const root = el('route-stats')
  const showAll = element('input')
  showAll.type = 'checkbox'
  const label = element('label', '显示全部角色')
  label.prepend(showAll)
  const clearDefaults = button('只填改动项', () => {
    for (const input of root.querySelectorAll('input[data-role]')) {
      if (Number(input.value) === Number(input.dataset.default)) input.value = ''
    }
  })
  const groups = script.roles.map(role => {
    const group = element('details')
    group.dataset.tier = role.tier ?? 'cast'
    group.dataset.hasStats = String(role.stats.length > 0)
    group.hidden = group.dataset.tier !== 'cast' || !role.stats.length
    group.append(element('summary', role.name + ' · ' + role.stats.length + ' 项'))
    if (!role.stats.length) group.append(element('p', '此角色没有数值项，角色设定仍会按需加载。'))
    for (const item of role.stats) {
      const input = element('input')
      input.type = 'number'
      input.min = '0'
      input.max = '100'
      input.step = '1'
      input.dataset.role = role.id
      input.dataset.stat = item.key
      input.dataset.default = item.default
      input.placeholder = '跟随默认：' + item.default
      const saved = route?.stats?.[role.id]?.[item.key]
      input.value = saved !== undefined && saved !== item.default ? saved : ''
      const field = element('label', item.key)
      field.append(input)
      group.append(field)
    }
    return group
  })
  showAll.addEventListener('change', () => groups.forEach(g => { g.hidden = !showAll.checked && (g.dataset.tier !== 'cast' || g.dataset.hasStats !== 'true') }))
  const castCount = script.roles.filter(role => !role.tier || role.tier === 'cast').length
  root.replaceChildren(label, clearDefaults, element('p', '本剧本 ' + castCount + ' 位核心角色；留空即跟随默认值，只保存改动项。'), ...groups)
  el('route-editor').showModal()
}

function saveRoute(event) {
  event.preventDefault()
  const inputs = [...el('route-stats').querySelectorAll('input[data-role]')]
  const stats = {}
  for (const input of inputs) {
    if (input.value === '' || input.valueAsNumber === Number(input.dataset.default)) continue
    stats[input.dataset.role] ??= {}
    stats[input.dataset.role][input.dataset.stat] = input.valueAsNumber
  }
  const route = {
    ...editingRoute,
    id: editingRoute?.id ?? 'route-' + crypto.randomUUID(),
    name: el('route-name').value.trim(),
    scene: el('route-scene').value,
    stats
  }
  const routes = editingRoute ? availableRoutes().map(item => item.id === route.id ? route : item)
    : [...availableRoutes().slice(0, -1), route, availableRoutes().at(-1)]
  try {
    draft.routes = validateRoutes(routes, script.roles)
  } catch (error) {
    el('route-error').textContent = error.message
    return
  }
  draft.routeId = route.id
  el('route-editor').close()
  renderRoutes()
  update()
}

function select(id) {
  script = scripts.get(id)
  document.body.dataset.story = id
  el('chat-input').placeholder = '说点什么，或者点上面的选项'
  draft = drafts.get(id) ?? createDraft(script)
  drafts.set(id, draft)
  el('script-title').textContent = script.title
  el('subtitle').textContent = script.subtitle
  el('hint').textContent = '🔑 ' + script.hint
  el('toggle-title').textContent = script.toggle.label + ' · ' + script.toggle.optionTitle
  el('toggle-description').textContent = script.toggle.optionDesc
  el('special').checked = draft.toggleOn
  el('custom').value = draft.customScene
  modelSelection()
  renderWorld()
  const roleGrid = element('div', undefined, 'quick-roles')
  roleGrid.dataset.count = script.roles.length
  roleGrid.style.setProperty('--columns', Math.min(script.roles.length, 3))
  roleGrid.style.setProperty('--mobile-columns', Math.min(script.roles.length, 2))
  roleGrid.append(...script.roles.filter(role => role.tier !== 'extra').map(role => button('🎭 ' + role.name + (role.stats.length ? ' · ' + role.stats[0].key : ''),
    () => detail(role.name, role.profile))))
  el('quick').replaceChildren(
    button('🏠 场景概况', () => detail('场景概况', worldText(draft.setting))),
    button('📝 入住与开局', () => {
      el('profile').scrollIntoView({ block: 'start' })
      inputs.values().next().value.focus({ preventScroll: true })
    }, 'primary'),
    roleGrid
  )
  renderFields()
  renderRoutes()
  update()
}

function showDrawer(onlyDrafts) {
  el('drawer-title').textContent = onlyDrafts ? '本地草稿历史' : '剧本库'
  el('drawer-status').textContent = ''
  const entries = [...scripts.values()].filter(item => !onlyDrafts || drafts.has(item.id))
  el('entries').replaceChildren(...entries.map(item => {
    const entry = button(item.title, () => {
      select(item.id)
      el('drawer').close()
    })
    entry.setAttribute('aria-current', String(item.id === script.id))
    const saved = drafts.get(item.id)
    entry.append(element('small', saved?.player.name ? '玩家 · ' + saved.player.name : item.subtitle))
    return entry
  }))
  if (!el('drawer').open) el('drawer').showModal()
}

function addLocal(config, saved) {
  scripts.set(config.id, config)
  localIds.add(config.id)
  if (saved) drafts.set(config.id, createDraft(config, saved))
  select(config.id)
  el('drawer').close()
}

function cloneId() {
  return 'script-' + crypto.randomUUID()
}

function closeSettings() {
  const panel = el('settings-dialog')
  if (panel.open) panel.close()
}

el('library').addEventListener('click', () => { if (script) showDrawer(false) })
el('history').addEventListener('click', () => { if (script) showDrawer(true) })
el('settings').addEventListener('click', () => {
  const panel = el('settings-dialog')
  if (!panel.open) {
    loadCredentialFields()
    panel.showModal()
  }
})
// ---------- 模型凭据：玩家自己填，只存在本机浏览器 ----------
// 这里没有任何「自动获取」：不读环境变量、不读配置文件、不向后端要 key。
// 打开设置看到的就是玩家自己上次填的东西，填完存在 localStorage。

const currentModel = () => (draft?.selectedModel || readCredentials().model || '')

async function reflectCredentialState() {
  const state = el('api-state')
  if (!state) return
  const { key, endpoint } = readCredentials()
  if (key.trim()) {
    state.textContent = '已填入 ' + maskKey(key) + '，发往 ' + (endpoint.trim() || DEFAULT_ENDPOINT) + '。同一网络的手机不用再填。'
    state.dataset.state = 'ok'
    return
  }
  // 本机没填过：看看服务端内存里有没有（电脑上填过，这台设备就能直接用）。
  if (await serverHasKey()) {
    state.textContent = '这台设备不用填：正用着电脑上填好的 key。'
    state.dataset.state = 'ok'
    return
  }
  state.textContent = '还没有 API Key。在任何一台电脑上填一次，手机端就不用再填。'
  state.dataset.state = 'empty'
}

function loadCredentialFields() {
  const { key, endpoint, model } = readCredentials()
  const endpointInput = el('api-endpoint')
  const keyInput = el('api-key')
  if (endpointInput) endpointInput.value = endpoint
  if (keyInput) keyInput.value = key
  const modelSelect = el('model')
  if (modelSelect && model) {
    if (!Array.from(modelSelect.options).some(option => option.value === model)) {
      const option = document.createElement('option')
      option.value = model
      option.textContent = model
      modelSelect.append(option)
    }
    modelSelect.value = model
  }
  reflectCredentialState()
}

el('api-endpoint')?.addEventListener('blur', async event => {
  saveCredentials({ endpoint: event.target.value.trim() })
  await pushCredentials()
  reflectCredentialState()
})
el('api-key')?.addEventListener('blur', async event => {
  saveCredentials({ key: event.target.value.trim() })
  await pushCredentials()
  reflectCredentialState()
})
el('api-clear')?.addEventListener('click', async () => {
  clearCredentials()
  await pushClear()
  loadCredentialFields()
})
el('api-test')?.addEventListener('click', async () => {
  const button = el('api-test')
  const state = el('api-state')
  if (!button || !state) return
  saveCredentials({
    endpoint: el('api-endpoint')?.value.trim() || '',
    key: el('api-key')?.value.trim() || ''
  })
  const { key, endpoint } = readCredentials()
  if (!key.trim()) {
    state.textContent = '先填 API Key 再测。'
    state.dataset.state = 'empty'
    return
  }
  button.disabled = true
  state.textContent = '正在连接…'
  try {
    const response = await fetch('./api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key.trim(),
        'x-model-endpoint': endpoint.trim() || DEFAULT_ENDPOINT
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 8, model: currentModel() })
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      state.textContent = '连接失败：' + (detail.error || ('HTTP ' + response.status))
      state.dataset.state = 'error'
      return
    }
    const reader = response.body?.getReader()
    if (reader) {
      await reader.read()
      reader.cancel().catch(() => {})
    }
    state.textContent = '连接正常，可以开始对话了。'
    state.dataset.state = 'ok'
  } catch (error) {
    state.textContent = '连不上：' + error.message
    state.dataset.state = 'error'
  } finally {
    button.disabled = false
  }
})

el('model-custom').addEventListener('click', () => {
  const name = window.prompt('输入目标模型名称（会作为 model 参数发给上游）。留空则用 API 地址那边的默认模型。', draft?.selectedModel || readCredentials().model || '')
  if (name === null) return
  const value = name.trim()
  saveCredentials({ model: value })
  if (!draft) {
    reflectCredentialState()
    return
  }
  draft.selectedModel = value
  modelSelection()
  update()
})
// 设置面板里的「主题」「历史」会打开另一个 modal dialog：先关面板，避免两个 dialog 同时 modal。
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return
  if (!event.target.closest('#theme-open, #history')) return
  closeSettings()
}, true)
el('model').addEventListener('change', event => {
  saveCredentials({ model: event.target.value })
  if (!draft) return
  draft.selectedModel = event.target.value
  update()
})
el('special').addEventListener('change', event => {
  draft.toggleOn = event.target.checked
  update()
})
el('custom').addEventListener('input', event => {
  draft.customScene = event.target.value
  update()
})
for (const key of worldFields) el('world-' + key).addEventListener('blur', applyWorld)
el('world-form').addEventListener('submit', event => {
  event.preventDefault()
  applyWorld()
})
el('reset-world').addEventListener('click', () => {
  draft.setting = { ...script.setting }
  renderWorld()
  update()
})
for (const [id, key] of [['world-panel', 'world'], ['memory-panel', 'memory']]) {
  el(id).addEventListener('toggle', event => {
    if (!draft || draft.panelOpen[key] === event.target.open) return
    draft.panelOpen[key] = event.target.open
    remember()
  })
}
el('add-route').addEventListener('click', () => editRoute())
el('route-form').addEventListener('submit', saveRoute)
el('random').addEventListener('click', () => {
  const taken = new Set()
  for (const field of script.playerFields) {
    const presets = field.chips ?? []
    if (!presets.length) continue
    const fresh = [...new Set(presets)].filter(preset => preset !== draft.player[field.key] && !taken.has(preset))
    const choices = fresh.length ? fresh : presets
    const choice = choices[Math.floor(Math.random() * choices.length)]
    taken.add(choice)
    inputs.get(field.key).value = choice
    draft.player[field.key] = choice
  }
  update()
})
el('copy').addEventListener('click', async () => {
  const output = el('output')
  try {
    await navigator.clipboard.writeText(output.textContent)
    el('copy-status').textContent = '已复制，粘贴到聊天窗口即可开始。'
  } catch {
    const range = document.createRange()
    range.selectNodeContents(output)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    el('copy-status').textContent = '浏览器未允许写入剪贴板，预览文字已选中，请手动复制。'
  }
})
el('new').addEventListener('click', () => {
  const title = window.prompt('为使用当前剧本模板的新草稿命名。', script.title + ' · 新草稿')
  if (!title?.trim()) return
  addLocal({ ...structuredClone(script), routes: structuredClone(availableRoutes()), id: cloneId(), title: title.trim() })
})
el('import').addEventListener('click', () => el('file').click())
el('file').addEventListener('change', async event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  try {
    if (file.size > 1024 * 1024) throw new Error('请选择 1 MB 以内的 JSON。')
    const value = JSON.parse((await file.text()).replace(/^\uFEFF/, ''))
    const config = validateScript(value?.script ?? value)
    if (scripts.has(config.id)) config.id = cloneId()
    addLocal(config, value?.draft)
  } catch (error) {
    el('drawer-status').textContent = '导入失败。' + error.message
  }
})
el('export').addEventListener('click', () => {
  const exported = { ...script, setting: draft.setting, routes: availableRoutes() }
  const { setting, routes, ...portableDraft } = draft
  const data = JSON.stringify({ script: exported, draft: portableDraft }, null, 2)
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const link = element('a')
  link.href = url
  link.download = script.id + '.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

async function json(path) {
  const response = await fetch(path)
  if (!response.ok) throw new Error('无法读取 ' + path)
  return response.json()
}

async function initialize() {
  try {
    const catalog = await json('./scripts/index.json')
    for (const config of await Promise.all(catalog.map(name => json('./scripts/' + encodeURIComponent(name))))) {
      validateScript(config)
      scripts.set(config.id, config)
    }
    let saved
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    } catch {
      saved = null
    }
    for (const config of Array.isArray(saved?.localScripts) ? saved.localScripts : []) {
      try {
        validateScript(config)
        if (scripts.has(config.id)) continue
        scripts.set(config.id, config)
        localIds.add(config.id)
      } catch {
        // Skip a damaged local script while leaving other drafts available.
      }
    }
    for (const entry of Array.isArray(saved?.drafts) ? saved.drafts : []) {
      const config = scripts.get(entry?.scriptId)
      if (config) drafts.set(config.id, createDraft(config, entry))
    }
    const id = scripts.has(saved?.active) ? saved.active : scripts.keys().next().value
    if (!id) throw new Error('剧本库为空。')
    select(id)
    el('workspace').hidden = false
  } catch (error) {
    el('notice').textContent = '加载失败。' + error.message
  }
}

initialize()

// 页面一打开就把本机的 key 递一份给服务端的内存，好在服务重启之后
// 手机端还能直接用。递的是玩家自己填过的东西，不是去翻本机凭据。
if (readCredentials().key.trim()) {
  pushCredentials().then(() => reflectCredentialState()).catch(() => {})
}








