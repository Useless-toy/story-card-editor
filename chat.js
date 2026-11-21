import { completePrismReply, customRequest, normalizeFanPlatforms, panelTitlesFromOpening, prepareRequestRoster, prismRequest, readStorySave, readStoryTranscript, settlePrismTurn, startLedger } from './compiler.mjs'
import { rosterWarnings } from './lib/roster.mjs'
import { mergePanelStats, panelStatDrops, prismPanels, splitChoices, splitPrismTurn, withLedgerAffection } from './lib/choices.mjs'
import { installedStoryScripts, openingForPlay } from './app.js'
import { DEFAULT_ENDPOINT, readCredentials } from './credentials.js'
import { changeSharedSlot, getSharedSlot, listSharedSlots, getSaveSlot as getLocalSlot,
  listSaveSlots as listLocalSlots, saveSlotCount } from './lib/save-slots.mjs'

const el = id => document.getElementById(id)

// 面板段落折叠只在手机（≤640px）生效。用 matchMedia 判视口，640px 以上恒为 false，
// 电脑端连 class 都不切；样式那边也只有 @media 块里才有对应规则。
const compactPanels = () => window.matchMedia('(max-width: 640px)').matches

const state = {
  messages: [],
  busy: false,
  prism: false,
  panelsMode: null,
  panelConfig: null,
  panels: new Map(),
  panelState: null,
  ledger: null,
  memory: null,
  roster: [],
  rosterAt: undefined,
  rosterLocation: undefined,
  game: null
}

function log() {
  return el('chat-log')
}

function status(text) {
  el('chat-status').textContent = text || ''
}

function renderContextBudget(context) {
  let node = el('chat-context-budget')
  if (!node) {
    node = document.createElement('small')
    node.id = 'chat-context-budget'
    node.style.display = 'block'
    node.style.whiteSpace = 'normal'
    el('chat-status').after(node)
  }
  node.textContent = context ? '本轮 system ' + context.total + '/' + context.budget.total + ' 字 · '
    + [['resident','规则'],['roster','角色'],['worldBook','世界书'],['basis','基准']]
      .map(([k,label]) => label + ' ' + context.sizes[k] + '/' + context.budget[k]).join(' · ')
    + (context.clipped.length ? ' · 已按预算裁剪：' + context.clipped.join('、') : '') : ''
}

function line(role, text) {
  const row = document.createElement('div')
  row.className = 'msg ' + role
  if (text) row.textContent = text
  log().appendChild(row)
  log().scrollTop = log().scrollHeight
  return row
}

function openingLine(text) {
  return line('user', text)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

/** 正文里的 **名字** 与 **「台词」** 转成红色描边（平台靠这条区分人和话）。 */
function highlightNames(text) {
  return escapeHtml(text).replace(/\*\*([^*\r\n]{1,80})\*\*/g, '<strong class="hl">$1</strong>')
}

function ledgerLines(title) {
  if (!state.ledger) return ''
  const { members, pairs } = state.ledger
  if (title === 'PRISM·成员状态') {
    const player = members['玩家']
    return player ? '玩家 · 人气 ' + player.popularity + ' · 唯粉 ' + player.soloFans +
      ' · 路人缘 ' + player.passers + '% · CP 粉 ' + player.cpFans : ''
  }
  if (title === '队友关系') {
    return Object.entries(members).filter(([name]) => name !== '玩家').map(([name, entry]) => {
      const values = [['affection', '好感'], ['trust', '信任'], ['suspicion', '怀疑']]
        .filter(([key]) => Number.isInteger(entry[key]))
        .map(([key, label]) => label + ' ' + entry[key])
      const change = state.ledger.affectionChanges?.find(item => item.name === name)
      const reason = change ? ' · 本轮 ' + (change.delta > 0 ? '+' : '') + change.delta + '（' + change.reason + '）' : ''
      return values.length ? name + ' · ' + values.join(' · ') + reason : ''
    }).filter(Boolean).join('\n')
  }
  if (title !== '团内CP热度榜') return ''
  const ranked = Object.entries(members).sort(([, a], [, b]) => b.popularity - a.popularity)
  return [...Object.entries(pairs).map(([name, pair]) => name + ' · 热度 ' + pair.heat + ' · CP 粉 ' + pair.fans),
    '', ...ranked.map(([name, member], index) => (index + 1) + '. ' + name + ' · 人气 ' + member.popularity + ' · 唯粉 ' + member.soloFans)
  ].join('\n')
}

function renderPrismPanels(bubble, panels, choices, checks) {
  const stack = document.createElement('div')
  stack.className = 'prism-panels'
  const audit = checks.length ? [{ title: '剧情检查摘要', text: checks.join('\n') }] : []
  // section 标记只加在真正的面板段落上（不含「下一步」）：手机端按 .panel-section 折叠，
  // 电脑端这个 class 没有任何样式对应，渲染出来的样子与改动前一致。
  const sections = [...audit, ...panels.map(panel => ({ ...panel, section: true })), { title: '下一步' }]
  for (const { title, text, carried, section } of sections) {
    const details = document.createElement('details')
    if (section) details.className = 'panel-section'
    const summary = document.createElement('summary')
    summary.textContent = title
    const content = document.createElement('div')
    content.className = 'prism-panel-content'
    if (title === '下一步') {
      if (!choices.length) content.textContent = '本轮暂无下一步，可自行输入。'
      for (const [index, choice] of choices.entries()) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'choice'
        button.textContent = (index + 1) + '. ' + choice
        button.addEventListener('click', () => {
          if (state.busy) return
          const input = el('chat-input')
          input.value = choice
          input.focus()
        })
        content.append(button)
      }
    } else {
      const ledger = ledgerLines(title)
      // 模型会在【队友关系】里照抄上一轮的好感数字，显示层按账本兜底（只改显示，不改存的正文）。
      const described = withLedgerAffection(title, text, state.ledger)
      const description = described ? (carried ? '沿用上一轮叙事说明\n' : '') + described : ''
      content.textContent = [ledger, description].filter(Boolean).join('\n\n') || '本轮暂无已确认信息。'
    }
    details.append(summary, content)
    stack.append(details)
  }
  bubble.append(stack)
}

// 自定义面板：标题由剧本自己声明（【面板清单】），这里只按顺序渲染，不再套 PRISM 的账本行。
function renderCustomPanels(bubble, panels, choices, warnings = []) {
  const stack = document.createElement('div')
  stack.className = 'prism-panels'
  for (const { title, text, carried } of panels) {
    const details = document.createElement('details')
    details.className = 'panel-section'
    // 电脑端保持「第一段默认展开」；手机端全部默认折叠（折叠态由 .is-open 控制）
    details.open = !compactPanels() && title === panels[0]?.title
    const summary = document.createElement('summary')
    summary.textContent = title
    const content = document.createElement('div')
    content.className = 'prism-panel-content'
    content.textContent = (carried ? '沿用上一轮\n' : '') + (text || '本轮暂无已确认信息。')
    details.append(summary, content)
    stack.append(details)
  }
  const actions = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = '下一步'
  const content = document.createElement('div')
  content.className = 'prism-panel-content'
  if (!choices.length) content.textContent = '本轮暂无下一步，可自行输入。'
  for (const [index, choice] of choices.entries()) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'choice'
    button.textContent = (index + 1) + '. ' + choice
    button.addEventListener('click', () => {
      if (state.busy) return
      const input = el('chat-input')
      input.value = choice
      input.focus()
    })
    content.append(button)
  }
  actions.append(summary, content)
  stack.append(actions)
  if (warnings.length) {
    const details = document.createElement('details')
    const warningSummary = document.createElement('summary')
    warningSummary.textContent = '结算提示'
    const warningContent = document.createElement('div')
    warningContent.className = 'prism-panel-content'
    warningContent.textContent = warnings.join('\n')
    details.append(warningSummary, warningContent)
    stack.append(details)
  }
  bubble.append(stack)
}

function parseTurn(text) {
  if (state.panelsMode === 'prism') return splitPrismTurn(text, state.panels)
  // 面板配置不能只靠 startGame 那一次判定：判成 null 时整段面板会原样留在正文里。
  // 这里按 opening 现算一次兜底，只要剧本里有【面板清单】，就一定按面板拆。
  let cfg = state.panelConfig
  if (!cfg) {
    const titles = panelTitlesFromOpening(state.game?.opening || '')
    if (titles) cfg = { titles, marker: 'PANEL', statsTitle: 'PANEL-STATS' }
  }
  if (cfg) {
    const parsed = splitPrismTurn(text, state.panels, cfg)
    const residue = /^[ \t]*(?:-{2,}[ \t]*PANEL[ \t]*-{2,}|【(角色信息|终端|你的状态|当前交互目标|记忆区|行动建议)】|\*\*(角色信息|终端|你的状态|当前交互目标|记忆区|行动建议)\*\*)[ \t]*$/im.exec(parsed.body)
    if (residue) return { ...parsed, body: parsed.body.slice(0, residue.index).trim() }
    return parsed
  }
  return splitChoices(text)
}

function clearChoices() {
  const box = el('choices')
  box.replaceChildren()
  box.hidden = true
}

function renderChoices(choices) {
  clearChoices()
  if (!choices.length) return
  const box = el('choices')
  choices.forEach((text, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'choice'
    button.textContent = (index + 1) + '. ' + text
    button.addEventListener('click', () => {
      if (state.busy) return
      el('chat-input').value = text
      submit()
    })
    box.appendChild(button)
  })
  box.hidden = false
}

// 上游偶尔只回内部推理（被 start.mjs 过滤掉）或直接空响应，正文就是空字符串。
// 服务端在这种情况下会补一句标记文案，两边都认。
const EMPTY_TURN_MARK = '本轮没有返回正文'
const isEmptyTurn = text => text.trim() === '' || text.includes(EMPTY_TURN_MARK)

function renderRetry() {
  const box = el('choices')
  box.replaceChildren()
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'choice'
  button.textContent = '↻ 重试这一轮'
  button.addEventListener('click', () => {
    if (state.busy) return
    run()
  })
  box.appendChild(button)
  box.hidden = false
}

async function submit() {
  if (state.busy) return
  const input = el('chat-input')
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }
  input.value = ''
  line('user', text)
  state.messages.push({ role: 'user', content: text })
  await run()
}

async function requestTurn(messages, onProgress) {
  const { key, endpoint, model } = readCredentials()
  if (!key.trim()) {
    throw new Error('还没有填 API Key。点右上角 ⚙，在「模型」里填好 key 再开始——它只存在你自己的浏览器里。')
  }
  const response = await fetch('./api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key.trim(),
      'x-model-endpoint': endpoint.trim() || DEFAULT_ENDPOINT
    },
    body: JSON.stringify({ messages, maxTokens: 6000, model: model || document.getElementById('model')?.value || undefined })
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: 'HTTP ' + response.status }))
    throw new Error(detail.error || ('HTTP ' + response.status))
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    full += decoder.decode(value, { stream: true })
    onProgress?.(full)
  }
  return full + decoder.decode()
}

async function run() {
  state.busy = true
  el('chat-send').disabled = true
  clearChoices()
  const bubble = line('assistant', '')
  status('正在生成…')

  let full = ''
  try {
    const turnMessages = state.game?.opening ? state.messages : state.messages.slice(1)
    const prepared = prepareRequestRoster(state.game?.opening || state.messages[0]?.content || '', turnMessages, state.roster, state.panels, state.rosterLocation)
    // 开局设定单独放在 state.game.opening 里，不进对话；只要它有内容就走 custom 通道，
    // 不再依赖 panelsMode 是否判定成功（否则 messages 为空会发出空请求）。
    const messages = state.panelsMode === 'prism'
      ? prismRequest(state.game?.opening ? [{ role: 'user', content: state.game.opening }, ...state.messages] : state.messages, state.panels, state.ledger, state.memory, prepared.roster)
      : state.game?.opening
        ? customRequest(state.messages, state.panels, state.panelState, state.panelConfig, state.game.opening, prepared.roster)
        : customRequest(state.messages, state.panels, state.panelState, state.panelConfig, undefined, prepared.roster)
    renderContextBudget(messages.context)
    full = await requestTurn(messages, text => {
      const feed = log()
      const follow = true
      bubble.textContent = parseTurn(text).body
      if (follow) feed.scrollTop = feed.scrollHeight
    })
    if (state.panelsMode === 'prism' && !isEmptyTurn(parseTurn(full).body)) {
      full = await completePrismReply(full, narrative => {
        status('正在补齐本轮面板与下一步…')
        return requestTurn([...messages, { role: 'assistant', content: narrative }, {
          role: 'user',
          content: '剧情正文已经写完并显示给玩家。请只补这一轮的状态与下一步，从 ---THINK--- 开始，按系统输出骨架写全八项、面板、账本与五条分类选项。不要复述正文，也不要推进到下一轮。'
        }])
      }, Boolean(state.ledger))
    }
    if (state.ledger?.fandom) full = normalizeFanPlatforms(full, state.ledger.fandom)
    let reply = parseTurn(full)
    // 自定义面板剧本：模型偶尔把面板和选项整段漏掉，只留正文。
    // 这里补一次「只写面板与选项」的请求，正文保留原来的，面板/账本/选项从补的里取。
    if (state.panelsMode === 'custom' && !isEmptyTurn(reply.body)
      && (reply.choices.length === 0 || reply.panels.length === 0)) {
      status('正在补齐本轮面板与选项…')
      const patch = await requestTurn([
        ...messages,
        { role: 'assistant', content: reply.body },
        {
          role: 'user',
          content: '正文已经写完并显示给玩家了。请只补这一轮的状态面板与选项，不要复述正文，也不要推进剧情：'
            + '从单独一行 ---PANEL--- 开始，按顺序逐段写全 '
            + state.panelConfig.titles.map(title => '【' + title + '】').join('')
            + '，标题照抄；然后单独一行 ---PANEL-STATS---，下一行只写 JSON 对象；'
            + '最后单独一行 ---CHOICES---，给出三条 ①②③ 开头的可执行选项。'
        }
      ])
      const fixed = parseTurn(patch)
      if (fixed.panels.length) reply = { ...reply, panels: fixed.panels }
      if (fixed.stats) reply = { ...reply, stats: fixed.stats }
      if (fixed.choices.length) reply = { ...reply, choices: fixed.choices }
      if (fixed.panels.length || fixed.choices.length) full = reply.body + '\n\n' + patch
    }
    const { body, choices, checks } = reply
    if (isEmptyTurn(body)) {
      // 不留空气泡。最后一条 user 消息**保留**——重试就是拿它再发一次，不新增一轮对话。
      bubble.remove()
      status('这一轮上游没返回正文（只有内部推理，已被过滤）。点「重试」再来一次。')
      renderRetry()
      return
    }
    bubble.innerHTML = highlightNames(body)
    const message = { role: 'assistant', content: full }
    if (state.panelsMode === 'prism') {
      const result = settlePrismTurn(state.memory, state.ledger, reply)
      state.memory = result.memory
      state.panels = new Map(result.panels.filter(panel => panel.text).map(panel => [panel.title, panel.text]))
      state.ledger = result.ledger
      if (result.warnings.length) {
        message.warnings = result.warnings
        console.warn('PRISM 好感结算', ...result.warnings)
      }
      renderPrismPanels(bubble, result.panels, choices, [...checks, ...result.warnings.map(warning => '结算提示：' + warning)])
      log().scrollTop = log().scrollHeight
    } else if (state.panelsMode === 'custom') {
      const before = state.panelState ? structuredClone(state.panelState) : null
      state.panels = new Map(reply.panels.filter(panel => panel.text).map(panel => [panel.title, panel.text]))
      state.panelState = mergePanelStats(state.panelState, reply.stats)
      const warnings = rosterWarnings(reply.panels, prepared.parts.roles, prepared.roster).slice(0, 5)
      if (state.panels.size && reply.panels.every(panel => panel.carried)) warnings.push('本轮没有解析到面板，已沿用上一轮原文。')
      for (const drop of panelStatDrops(before, state.panelState).slice(0, 6)) warnings.push('面板数值下行：' + drop)
      if (warnings.length) {
        message.warnings = warnings
        console.warn('面板结算', ...warnings)
      }
      renderCustomPanels(bubble, reply.panels, choices, warnings)
      log().scrollTop = log().scrollHeight
    } else {
      renderChoices(choices)
    }
    state.messages.push(message)
    // Commit presence only after a successful nonempty reply; failed requests/retries leave it untouched.
    state.roster = prepared.roster
    state.rosterAt = state.messages.length - 1
    state.rosterLocation = prepared.location
    status(choices.length ? '选一个方向，或者自己写。' : '')
  } catch (error) {
    bubble.textContent = '[出错] ' + error.message
    status('本轮请求失败，可以重试。')
    renderRetry()
  } finally {
    state.busy = false
    el('chat-send').disabled = false
    if (!compactPanels() && !document.querySelector('dialog[open]')) {
      el('chat-input').focus()
    }
  }
}

function startGame() {
  if (state.busy) return
  if (!el('output').textContent.trim()) {
    status('开局内容是空的，先检查上面的预览。')
    return
  }
  if (state.messages.length && !window.confirm('对话已有内容，重新开始会清空。继续吗？')) return
  const opening = openingForPlay().trim()
  log().replaceChildren()
  clearChoices()
  state.prism = opening.includes('【PRISM 每轮状态协议】')
  const panelTitles = state.prism ? null : panelTitlesFromOpening(opening)
  state.panelConfig = panelTitles ? { titles: panelTitles, marker: 'PANEL', statsTitle: 'PANEL-STATS' } : null
  state.panelsMode = state.prism ? 'prism' : state.panelConfig ? 'custom' : null
  state.panelState = state.panelsMode === 'custom' ? {} : null
  state.memory = state.panelsMode === 'prism' ? { recent: [], archive: [], nextId: 1 } : null
  const seed = el('output').dataset.prismStats
  state.ledger = state.panelsMode === 'prism' && seed ? startLedger(JSON.parse(seed), JSON.parse(el('output').dataset.prismFans || '[]')) : null
  state.panels.clear()
  state.game = {
    scriptId: el('output').dataset.scriptId,
    scriptTitle: el('script-title').textContent,
    player: JSON.parse(el('output').dataset.player || '{}'),
    opening
  }
  state.messages = []
  state.roster = []
  state.rosterAt = undefined
  state.rosterLocation = undefined
  renderContextBudget(null)
  status('设定已载入（模式:' + state.panelsMode + '，设定 ' + opening.length + ' 字），正在写第一轮…')
  run()
}

el('start').addEventListener('click', startGame)
el('chat-send').addEventListener('click', submit)

el('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
})

el('chat-reset').addEventListener('click', () => {
  if (state.busy || !state.messages.length) return
  if (!window.confirm('清空当前对话？')) return
  state.messages = []
  state.game = null
  renderContextBudget(null)
  state.roster = []
  state.rosterAt = undefined
  state.rosterLocation = undefined
  state.prism = false
  state.panelsMode = null
  state.panelConfig = null
  state.panelState = null
  state.ledger = null
  state.memory = null
  state.panels.clear()
  log().replaceChildren()
  clearChoices()
  status('已清空。点「开始游戏」重新开局。')
})

el('chat-export-novel').addEventListener('click', () => {
  if (!state.messages.length) {
    status('还没有对话内容。')
    return
  }
  const title = state.game?.scriptTitle || '未命名'
  const chunks = []
  let rawChars = 0
  let bodyChars = 0
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue
    rawChars += String(message.content || '').length
    // parseTurn 已经按当前剧本的面板模式切好，body 就是纯正文
    const body = String(parseTurn(String(message.content || '')).body || '').trim()
    if (!body) continue
    bodyChars += body.length
    chunks.push('## 第 ' + (chunks.length + 1) + ' 轮\n\n' + body)
  }
  if (!chunks.length) {
    status('没有可导出的正文。')
    return
  }
  const removed = rawChars > 0 ? Math.round((1 - bodyChars / rawChars) * 100) : 0
  const text = '# ' + title + '\n\n（共 ' + chunks.length + ' 轮，正文 ' + bodyChars + ' 字）\n\n'
    + chunks.join('\n\n')
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = (state.game?.scriptId || 'story') + '-正文-'
    + new Date().toISOString().slice(0, 10) + '.md'
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  status('已导出正文：' + chunks.length + ' 轮 / ' + bodyChars + ' 字（去掉 ' + removed + '% 的思考与面板）')
})

el('chat-export').addEventListener('click', () => {
  if (!state.messages.length) {
    status('还没有对话内容。')
    return
  }
  const title = state.game?.scriptTitle || '角色'
  const text = state.messages
    .map(message => (message.role === 'user' ? '【玩家】' : '【' + title + '】') + '\n' + message.content)
    .join('\n\n---\n\n')
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'chat-' + new Date().toISOString().slice(0, 10) + '.txt'
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  status('已导出。')
})







function captureSave() {
  if (state.busy) throw new Error('请等本轮回复结束后再存档。')
  if (!state.game) throw new Error('请先开始游戏。')
  return {
    kind: 'story-card-save',
    version: 1,
    ...state.game,
    prism: state.prism,
    panelsMode: state.panelsMode,
    savedAt: new Date().toISOString(),
    messages: state.messages,
    panels: [...state.panels],
    panelState: state.panelState,
    roster: state.roster,
    rosterAt: state.rosterAt,
    rosterLocation: state.rosterLocation,
    ledger: state.ledger,
    memory: state.memory
  }
}

el('chat-save').addEventListener('click', () => {
  let save
  try {
    save = captureSave()
  } catch (error) {
    status(error.message)
    return
  }
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }))
  link.download = 'save-' + save.scriptId + '-' + save.savedAt.slice(0, 10) + '.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  status('续玩存档已导出。')
})

const saveFile = el('chat-save-file')
el('chat-load').addEventListener('click', () => {
  if (state.busy) {
    status('请等本轮回复结束后再导入。')
    return
  }
  saveFile.click()
})

async function readSaveFile(file) {
  if (file.size > 32 * 1024 * 1024) throw new Error('存档超过 32 MB。')
  const source = (await file.text()).replace(/^\uFEFF/, '')
  const transcript = /\.txt$/i.test(file.name) || source.startsWith('【玩家】')
  const restored = transcript ? readStoryTranscript(source, installedStoryScripts(), el('output').dataset.scriptId) : null
  const raw = restored ? restored.save : JSON.parse(source)
  const save = readStorySave(raw)
  const missing = restored?.missingLedgerTurns
  return { save, transcript, summary: missing ? '有 ' + missing + ' 轮缺少可恢复的账本数据。' : '' }
}

function restoreSave(save, { transcript = false, summary = '' } = {}) {
  if (state.busy) throw new Error('请等本轮回复结束后再载入。')
  const current = el('output').dataset.scriptId
  const mismatch = current && save.scriptId !== current
  const replace = state.messages.length > 0
  if ((mismatch || replace) && !window.confirm(
    (mismatch ? '存档来自「' + save.scriptTitle + '」，与当前选中的剧本不同。' : '') +
    (replace ? '载入会替换当前对话。' : '') + '继续载入此存档？'
  )) return false

  state.game = { scriptId: save.scriptId, scriptTitle: save.scriptTitle, player: save.player, opening: save.opening || '' }
  state.messages = save.messages
  state.roster = save.roster ?? []
  state.rosterAt = save.rosterAt
  state.rosterLocation = save.rosterLocation
  renderContextBudget(null)
  state.prism = save.prism
  state.panels = new Map(Array.isArray(save.panels) ? save.panels : save.panels ? [...save.panels] : [])
  state.panelState = save.panelState ?? null
  // 面板清单写在「开场」里（compile 产物），不在第一条消息里——存档自带 opening 时优先用它。
  const restoredTitles = state.prism ? null : panelTitlesFromOpening(save.opening || save.messages[0]?.content)
  state.panelConfig = restoredTitles ? { titles: restoredTitles, marker: 'PANEL', statsTitle: 'PANEL-STATS' } : null
  // 面板模式不能只靠「开场里有标题」或「存档写了 panelsMode」判断：
  // 存档槽（save-slots）不写 panelsMode，而不少剧本的开场本来就不含面板标题。
  // 只要存档里带了面板正文，就该按 custom 还原，否则读档后状态栏会整块消失。
  const restoredPanelPairs = Array.isArray(save.panels) ? save.panels : save.panels ? [...save.panels] : []
  state.panelsMode = state.prism ? 'prism'
    : (restoredPanelPairs.length > 0 || save.panelsMode === 'custom' || state.panelConfig) ? 'custom'
    : null
  state.ledger = save.ledger
  if (state.ledger && !state.ledger.fandom && save.scriptId === current) {
    const fans = JSON.parse(el('output').dataset.prismFans || '[]')
    if (fans.length) state.ledger.fandom = { profiles: fans, posts: [] }
  }
  state.memory = save.memory
  log().replaceChildren()
  clearChoices()
  const lastReply = state.messages.findLastIndex(message => message.role === 'assistant')
  for (const [index, message] of state.messages.entries()) {
    if (message.role === 'user') {
      if (index === 0) openingLine(message.content)
      else line('user', message.content)
      continue
    }
    const reply = parseTurn(message.content)
    const bubble = line('assistant', reply.body)
    if (index !== lastReply) continue
    if (state.panelsMode === 'prism') {
      const panels = prismPanels.map(([title]) => ({ title, text: state.panels.get(title) ?? '' }))
      renderPrismPanels(bubble, panels, reply.choices, [...reply.checks, ...(message.warnings ?? []).map(warning => '结算提示：' + warning)])
    } else if (state.panelsMode === 'custom') {
      const panels = [...state.panels].map(([title, text]) => ({ title, text, carried: false }))
      renderCustomPanels(bubble, panels, reply.choices, message.warnings ?? [])
    } else {
      renderChoices(reply.choices)
    }
  }
  el('chat-input').value = ''
  log().scrollTop = log().scrollHeight
  if (state.messages.at(-1).role === 'user') renderRetry()
  status((transcript ? '已载入旧记录「' : '已载入「') + save.scriptTitle + '」，可继续下一轮。' + summary)
  return true
}

saveFile.addEventListener('change', async () => {
  const file = saveFile.files[0]
  saveFile.value = ''
  if (!file) return
  try {
    const result = await readSaveFile(file)
    restoreSave(result.save, result)
  } catch (error) {
    status('导入失败。' + error.message)
  }
})

const slotsDialog = el('save-slots-dialog')
const slotsGrid = el('slots-grid')
const slotFile = el('slot-file')
const slotTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })
let pendingImport = null
let slotsBusy = false

function slotStatus(message) {
  el('slots-status').textContent = message
}

function slotButton(label, click) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', click)
  return button
}

function slotDefaultName(title, turns) {
  const suffix = ' · 第 ' + turns + ' 轮'
  return [...title].slice(0, 30 - [...suffix].length).join('') + suffix
}

function clearSlotImport() {
  pendingImport = null
  el('slot-import-cancel').hidden = true
  el('slot-legacy-picker').hidden = true
}

async function slotTask(action) {
  if (slotsBusy) return
  slotsBusy = true
  try {
    await action()
  } catch (error) {
    slotStatus(error.message || '无法访问共享存档。')
  } finally {
    slotsBusy = false
  }
}

async function mutateSlot(slot, entry, operation) {
  if (!await changeSharedSlot(slot, entry, operation)) {
    await renderSlots()
    throw new Error('该槽位已在其他设备修改，请核对后再试。')
  }
}

async function saveToSlot(slot, entry) {
  const source = pendingImport?.save ?? captureSave()
  if (entry && !window.confirm('槽位 ' + slot + ' 已有存档，覆盖？')) return
  const turns = source.messages.filter(message => message.role === 'assistant').length
  const name = pendingImport?.name ?? (entry?.scriptId === source.scriptId ? entry.name : slotDefaultName(source.scriptTitle, turns))
  const { summary = '' } = pendingImport ?? {}
  await mutateSlot(slot, entry, {
    kind: 'save',
    save: { ...source, savedAt: new Date().toISOString(), name, turns }
  })
  clearSlotImport()
  await renderSlots()
  slotStatus('已保存到槽位 ' + slot + '。' + summary)
}

async function renderSlots() {
  const entries = new Map((await listSharedSlots()).map(entry => [entry.slot, entry]))
  const grid = document.createDocumentFragment()
  for (let slot = 1; slot <= saveSlotCount; slot++) {
    const entry = entries.get(slot)
    const card = document.createElement('article')
    card.className = 'save-slot' + (entry ? '' : ' empty')
    card.dataset.slot = slot
    const header = document.createElement('header')
    const number = document.createElement('strong')
    number.textContent = '槽位 ' + slot
    header.append(number)
    const title = document.createElement('h3')
    title.textContent = entry?.name ?? '空'
    const actions = document.createElement('div')
    actions.className = 'save-slot-actions'
    actions.append(slotButton(pendingImport ? '导入到此' : entry ? '保存' : '保存到此', () =>
      slotTask(() => saveToSlot(slot, entry))))
    card.append(header, title)
    if (entry) {
      const time = document.createElement('time')
      time.dateTime = entry.savedAt
      time.textContent = slotTime.format(new Date(entry.savedAt))
      header.append(time)
      const details = document.createElement('p')
      details.textContent = entry.scriptTitle + ' · 第 ' + entry.turns + ' 轮'
      card.append(details)
      actions.append(slotButton('读取', () => slotTask(async () => {
        const stored = await getSharedSlot(slot)
        if (!stored) {
          await renderSlots()
          throw new Error('该槽位已被删除。')
        }
        if (restoreSave(readStorySave(stored))) slotsDialog.close()
      })))
      const menu = document.createElement('details')
      menu.className = 'save-slot-menu'
      const trigger = document.createElement('summary')
      trigger.textContent = '⋯'
      trigger.setAttribute('aria-label', '槽位 ' + slot + ' 的更多操作')
      const menuActions = document.createElement('div')
      menuActions.className = 'save-slot-actions'
      menuActions.append(
        slotButton('重命名', () => slotTask(async () => {
          const input = window.prompt('输入存档名称（最多 30 字）', entry.name)
          if (input === null) return
          const name = input.trim() || slotDefaultName(entry.scriptTitle, entry.turns)
          if ([...name].length > 30) throw new Error('存档名称不能超过 30 字。')
          await mutateSlot(slot, entry, { kind: 'rename', name })
          await renderSlots()
          slotStatus('槽位 ' + slot + ' 已重命名。')
        })),
        slotButton('删除', () => slotTask(async () => {
          if (!window.confirm('删除槽位 ' + slot + ' 的存档？')) return
          await mutateSlot(slot, entry, { kind: 'delete' })
          await renderSlots()
          slotStatus('槽位 ' + slot + ' 已清空。')
        }))
      )
      menu.append(trigger, menuActions)
      card.append(actions, menu)
    } else {
      card.append(actions)
    }
    grid.append(card)
  }
  slotsGrid.replaceChildren(grid)
}

function openSlots() {
  if (slotsBusy || slotsDialog.open) return
  if (el('settings-dialog').open) el('settings-dialog').close()
  slotsGrid.replaceChildren()
  slotsDialog.showModal()
  slotStatus('')
  slotTask(renderSlots)
}
el('chat-slots').addEventListener('click', openSlots)
el('slots-shortcut').addEventListener('click', openSlots)
slotsDialog.addEventListener('close', clearSlotImport)
el('slot-refresh').addEventListener('click', () => slotTask(async () => {
  await renderSlots()
  if (!pendingImport) slotStatus('共享槽位已刷新。')
}))
el('slot-legacy').addEventListener('click', () => slotTask(async () => {
  const entries = await listLocalSlots()
  if (!slotsDialog.open) return
  el('slot-legacy-picker').hidden = entries.length === 0
  if (!entries.length) {
    slotStatus('这个浏览器和当前网址下没有旧存档。')
    return
  }
  el('slot-legacy-select').replaceChildren(...entries.map(entry => new Option('槽位 ' + entry.slot + ' · ' + entry.name, entry.slot)))
  slotStatus('请选择要迁移的旧存档。')
}))
el('slot-legacy-pick').addEventListener('click', () => slotTask(async () => {
  const local = await getLocalSlot(Number(el('slot-legacy-select').value))
  if (!slotsDialog.open) return
  if (!local) throw new Error('找不到所选旧存档。')
  pendingImport = { save: readStorySave(local), name: local.name }
  el('slot-legacy-picker').hidden = true
  el('slot-import-cancel').hidden = false
  await renderSlots()
  slotStatus('已选中「' + local.name + '」，请选择目标共享槽位。')
}))
el('slot-import').addEventListener('click', () => { if (!slotsBusy) slotFile.click() })
el('slot-import-cancel').addEventListener('click', () => slotTask(async () => {
  clearSlotImport()
  await renderSlots()
  slotStatus('已取消导入。')
}))
slotFile.addEventListener('change', () => {
  const file = slotFile.files[0]
  slotFile.value = ''
  if (!file) return
  slotTask(async () => {
    const result = await readSaveFile(file)
    if (!slotsDialog.open) return
    pendingImport = result
    el('slot-import-cancel').hidden = false
    await renderSlots()
    slotStatus('已读取「' + result.save.scriptTitle + '」，请选择目标槽位。' + result.summary)
  })
})

// ── 手机端纵向压缩：纯 UI 的 class 切换，不碰任何数据流 ──────────────────────
// 「是否已开局」只认 DOM：#chat-log 里有没有 .msg。这样刷新页面重放存档、
// 导入续玩、清空对话都不需要额外记账，样式跟着 DOM 自动对。
// 640px 以上 is-playing / config-open 没有任何规则对应，电脑端等于没变。
const mobileConfigToggle = el('mobile-config-toggle')
const mobileConfigTitle = el('mobile-config-title')

function setConfigOpen(open) {
  document.body.classList.toggle('config-open', open)
  mobileConfigToggle?.setAttribute('aria-expanded', String(open))
}

function syncPlayingState() {
  const playing = !!log()?.querySelector('.msg')
  const wasPlaying = document.body.classList.contains('is-playing')
  document.body.classList.toggle('is-playing', playing)
  // 只在「刚开局」这一下自动收起：之后用户自己点开摘要条就尊重他的选择
  if (playing && !wasPlaying) setConfigOpen(false)
}

function syncConfigTitle() {
  if (!mobileConfigTitle) return
  const title = (el('script-title')?.textContent || '').trim()
  mobileConfigTitle.textContent = title || '剧本卡片'
}

if (log()) {
  new MutationObserver(syncPlayingState).observe(log(), { childList: true })
  syncPlayingState()
}
const scriptTitleEl = el('script-title')
if (scriptTitleEl) {
  new MutationObserver(syncConfigTitle).observe(scriptTitleEl, { childList: true, characterData: true, subtree: true })
  syncConfigTitle()
}
mobileConfigToggle?.addEventListener('click', () => {
  setConfigOpen(!document.body.classList.contains('config-open'))
})

// ── 面板段落折叠（仅手机）：点标题行切 is-open，样式在 style.css 的 @media 块里 ────────
// 事件委托挂在 #chat-log 上——气泡是动态创建的，不重新绑监听。
// compactPanels() 为 false（电脑端）时这个函数直接返回，DOM 一个 class 都不动；
// 折叠与否只由 .is-open 决定，details.open 仅用于对齐原生状态与无障碍语义。
if (log()) {
  log().addEventListener('click', event => {
    if (!compactPanels()) return
    const summary = event.target instanceof Element ? event.target.closest('summary') : null
    const section = summary?.closest('details.panel-section')
    if (!section || !log().contains(section)) return
    event.preventDefault()
    const open = section.classList.toggle('is-open')
    section.open = open
    summary.setAttribute('aria-expanded', String(open))
  })
}


