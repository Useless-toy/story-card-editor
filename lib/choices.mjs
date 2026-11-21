const MARK = /^[ \t]*(?:-{2,}[ \t]*CHOICES[ \t]*(?:-{2,})?|【[ \t]*CHOICES[ \t]*】)[ \t]*(?=\r?$)/gim

// 兜底：一条孤立的分隔线，后面紧跟 ①②③ 开头的列表。
// 模型偶尔会漏写 CHOICES 这个词，只留一条 ---。
const LOOSE = /\n[ \t]*-{3,}[ \t]*\r?\n(?=[ \t]*[①②③④⑤])/

const ITEM = /^(?:[①②③④⑤⑥⑦⑧⑨]|[-*•]|\d+[.、)）])[ \t]*/

// 模型有时会先写一条孤立的分隔线，再写标准标记，
// 那条多余的 --- 会留在正文末尾，这里去掉。
const TAIL = /\s*\n[ \t]*-{3,}\s*$/

const trim = body => body.trimEnd().replace(TAIL, '').trimEnd()

function parseItems(block) {
  return block
    .split(/\r?\n/)
    .map(line => line.trim().replace(ITEM, '').trim())
    .filter(Boolean)
    // 曾经是 slice(0, 3)：模型偶尔给 4–5 条，第 4 条就被静默吞掉，页面上看不出来。
    // 改为不吞，只封顶到 9（对应 ①–⑨ 的编号范围），异常长列表也不至于把界面撑爆。
    .slice(0, 9)
}

export function splitChoices(text) {
  const marks = [...text.matchAll(MARK)]
  const mark = marks.at(-1)
  if (mark) {
    return {
      body: trim(text.slice(0, mark.index)),
      choices: parseItems(text.slice(mark.index + mark[0].length))
    }
  }

  const loose = text.match(LOOSE)
  if (loose) {
    return {
      body: trim(text.slice(0, loose.index)),
      choices: parseItems(text.slice(loose.index + loose[0].length))
    }
  }

  return { body: text, choices: [] }
}

export const prismChecks = [
  ['场景判断', '时间、地点和当前场景。'],
  ['信息传播', '列明谁在场、谁知道、通过什么载体传播。尚无传播时写无。'],
  ['好感度变化', '本轮确认的好感变化及可见事件。'],
  ['人气变化', '本轮公开曝光及确认的人气变化。'],
  ['随机事件', '本轮实际触发的事件，或写无。'],
  ['暧昧判断', '本轮已有的互动或信号，或写无。'],
  ['角色性格检验', '哪项已呈现的行为符合人物设定。'],
  ['文风', '本轮采用的叙事视角和呈现方式。']
]

export const prismPanels = [
  ['当前情况', '故事内日期、时间、地点、天气和当前局势。'],
  ['PRISM·成员状态', '玩家排名、人气及变动、路人缘、粉丝数、唯粉满意度、当月收入、处境与当前CP。未知项写未确认。'],
  ['队友关系', '六位队友各自的好感、变动理由、关系阶段、动态与对玩家的态度。'],
  ['团内CP热度榜', '组合热度、变动、粉丝数与公开事件，以及七人当前人气排行。'],
  ['工作日程 & 本周事件', '按日期列出已完成、待办、改期、私约和公司通知。'],
  ['工作记忆', '最多四条带日期的近期关键事实、承诺或未解决事项。'],
  ['历史档案', '保留此前的重要事实，将移出工作记忆但仍影响剧情的事项归档。']
]

const prismTitles = new Map([
  ...prismPanels.map(([title]) => [title.replace(/\s/g, ''), title]),
  ['成员状态', 'PRISM·成员状态'],
  ['CP热度榜', '团内CP热度榜'],
  ['工作日程与本周事件', '工作日程 & 本周事件'],
  ['行动推荐', '行动推荐'],
  ['PRISM-STATS', 'PRISM-STATS']
])

// ---------------------------------------------------------------------------
// 面板配置：PRISM 是「不传 config」的默认路径（一张写死的表），
// 剧本可以在 turnPanels 里自带一套标题，走同一条解析管线。
//   config = { titles: ['交互面板', …], marker: 'PANEL', statsTitle: 'PANEL-STATS' }
// 不传 config 时行为与加 config 之前逐字一致。
// ---------------------------------------------------------------------------

export function panelTitlesOf(config) {
  return Array.isArray(config?.titles) && config.titles.length ? config.titles : prismPanels.map(([title]) => title)
}

function panelTitleMap(config, statsTitle) {
  if (!config) return prismTitles
  const map = new Map(panelTitlesOf(config).map(title => [title.replace(/\s/g, ''), title]))
  map.set('行动推荐', '行动推荐')
  map.set(statsTitle.replace(/\s/g, ''), statsTitle)
  return map
}

const markerNameOf = config => (typeof config?.marker === 'string' && config.marker ? config.marker : 'PRISM')
export const panelStatsTitle = config => (typeof config?.statsTitle === 'string' && config.statsTitle ? config.statsTitle : 'PRISM-STATS')

export function splitPrismTurn(text, previous = new Map(), config = null) {
  const { body, choices } = splitChoices(text)
  const statsTitle = panelStatsTitle(config)
  const titles = panelTitleMap(config, statsTitle)
  const marker = new RegExp('^[ \\t]*-{3,}[ \\t]*' + escapeRegExp(markerNameOf(config)) + '[ \\t]*-{3,}[ \\t]*\\r?$', 'im').exec(body)
  const start = marker ? marker.index + marker[0].length : 0
  const tail = body.slice(start)
  // 标题兼容三种写法：【标题】、**【标题】**、**标题**（模型有时用 Markdown 粗体包住整个标题）。
  // **标题** 这一支不会误伤正文里的粗体：下面 filter(title) 只认 config.titles 白名单里的名字。
  const heading = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*{2}|__)?[ \\t]*(?:【([^】\\r\\n]+)】|\\*\\*([^*\\r\\n]+)\\*\\*|__([^_\\r\\n]+)__|-{2,}[ \\t]*'
    + escapeRegExp(statsTitle) + '[ \\t]*(?:-{2,})?)[ \\t]*(?:\\*{2}|__)?[ \\t]*[:：]?[ \\t]*\\r?$', 'gm')
  const headings = [...tail.matchAll(heading)]
    .map(match => ({
      index: match.index,
      end: match.index + match[0].length,
      title: titles.get((match[1] ?? match[2] ?? match[3] ?? statsTitle).trim().replace(/\s/g, ''))
    }))
    .filter(heading => heading.title)

  const sections = new Map()
  for (const [index, heading] of headings.entries()) {
    const value = tail.slice(heading.end, headings[index + 1]?.index).trim()
    if (value) sections.set(heading.title, value)
  }

  let stats
  try {
    stats = JSON.parse(sections.get(statsTitle) ?? 'null')
  } catch {
    // A truncated or invalid ledger proposal leaves confirmed values in place.
  }
  const panelBoundary = marker?.index ?? headings[0]?.index
  const narrative = body.slice(0, panelBoundary)
  const checkMarker = /^[ \t]*---THINK---[ \t]*\r?$/im.exec(narrative)
  const boundary = checkMarker?.index ?? panelBoundary
  const checkText = checkMarker ? narrative.slice(checkMarker.index + checkMarker[0].length) : ''
  const checks = checkText.split(/\r?\n/).map(line => line.trim()).filter(line => {
    const item = /^([1-8])\.[ \t]*([^：:]+)[：:][ \t]*\S/.exec(line)
    return item && prismChecks[Number(item[1]) - 1][0] === item[2].trim()
  })
  return {
    body: boundary === undefined ? body : trim(body.slice(0, boundary)),
    context: headings.reduceRight((result, heading, index) => {
      if (!memoryTitles.includes(heading.title)) return result
      const end = headings[index + 1]?.index ?? tail.length
      return result.slice(0, start + heading.index) + result.slice(start + end)
    }, text),
    stats,
    checks,
    choices: choices.length ? choices : parseItems(sections.get('行动推荐') ?? ''),
    panels: panelTitlesOf(config).map(title => ({
      title,
      text: sections.get(title) ?? previous.get(title) ?? '',
      carried: !sections.has(title) && previous.has(title)
    }))
  }
}

// 自定义面板的数值账本：{ day, 角色: { 键: 数值 } } 这类浅层结构。
// 合并规则：对象逐层合并（最多两层），数值/字符串/布尔直接覆盖，数组替换。
// 数值只增不减的字段（性次数一类）由剧本协议约束，引擎只做记录与告警。
export function mergePanelStats(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return previous ?? null
  const next = previous && typeof previous === 'object' && !Array.isArray(previous) ? structuredClone(previous) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergePanelStats(next[key], value)
    } else {
      const number = typeof value === 'string' && /^\s*(-?\d+(?:\.\d+)?)\s*(?:[（(][^\n]*[）)]|(?:→|➝|->)\s*[^\n]*)?\s*$/.exec(value)
      next[key] = number && Number.isFinite(Number(number[1])) ? Number(number[1]) : structuredClone(value)
    }
  }
  return next
}

// 面板数值里的下行：不拦，但要留证。已写出的数字掉头，正文里必须有对应的依据。
export function panelStatDrops(previous, next) {
  const drops = []
  if (!previous || !next) return drops
  for (const [group, values] of Object.entries(next)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    for (const [name, entry] of Object.entries(values)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const before = previous[group]?.[name]
      if (!before || typeof before !== 'object') continue
      for (const [field, value] of Object.entries(entry)) {
        if (!Number.isFinite(value) || !Number.isFinite(before[field])) continue
        if (value < before[field]) drops.push(group + '·' + name + ' 的「' + field + '」' + before[field] + '→' + value)
      }
    }
  }
  return drops
}



const memoryTitles = ['工作记忆', '历史档案']
const workingLimit = 4
// 比对键：去空白 + 去标点 + 取前 24 字。
// 原来的 remove(/\\s/g) 只吃空白，「苏暖问许恩霏今晚是否回来睡」和「苏暖问是否回来睡」
// 会被当成两条不同的记忆，同一件事因此在档案里存三份、越滚越大。
const normalizeMemory = value => value
  .replace(/[\s，。、；：！？…—－\-（）()「」『』“”"'’·*#]+/g, '')
  .slice(0, 24)
const sourcesOf = entry => entry.sources ?? [entry]
const archiveText = entry => '[' + entry.id + '] ' + entry.text
const memoryLength = value => [...value].length

export const prismMemoryProtocol = [
  '【记忆规则】工作记忆每轮通常只记 1 条本轮已发生的关键事实，确有两件独立大事可写 2 条。每行格式为 [1] 【公开】或 [1] 【知情：姓名、姓名】，后接日期、人物、行动和后果。仅玩家知晓写【知情：玩家】。承诺或伏笔尚未兑现可在知情标记后加【待办】。没有新事实写「无新增」。已经记录的事实不用重写。',
  '其他面板只记录该面板所需的状态，私下承诺及其具体条件只放工作记忆。公开工作日程可以照常列出。',
  '新增使工作记忆超过 4 条时，在历史档案写一行 [合并 旧编号+旧编号] 概括最旧两条，沿用输入里的编号，正文至多 40 字。保留参与者、约定和后果，勿添加事实。两条知情范围不同则交给程序归档。不要在历史档案另写新增事实。',
  '召回的记忆用于维持连续性。只有标注知情的人能在剧情中引用私下事件，公开事实也需要合理的传播途径。记忆没有标注知情范围时，不据此让角色声称知情。只在有自然衔接时提起旧事。较新的明确结果优先于旧档案里仍待完成的状态。'
]

export const prismArchivePriorityRule = '【归档优先级】先保留已发生的关系与身份转折（首次、确立、断裂、公开），再保留承诺与欠账、公开事件的结果，最后是日程与待办。合并摘要把最高优先级事实写在最前面。'

function memoryPriority(entry) {
  const fact = entry.text.replace(/^(?:【[^】]+】)+/, '')
  if (entry.text.includes('【里程碑】') || /第一次|首次|确立|断裂|决裂|背叛|公开(?:支持|关系|身份)/.test(fact)) return 3
  if (/承诺|答应|欠账|欠下/.test(fact)) return 2
  if (/热搜|代言|塌房|公开|官宣/.test(fact)) return 1
  return 0
}

function audience(text) {
  if (text.startsWith('【公开】')) return null
  const names = /^【知情[：:]([^】]+)】/.exec(text)?.[1]
  return names ? names.split(/[、，,]/).map(name => name.trim()).filter(Boolean).sort() : []
}

function memoryTopic(entry) {
  return entry.text.replace(/^(?:【[^】]+】|[（(][^）)]+[）)])+\s*/, '').split(/[，。；！？;!?\n]/)[0].trim()
}

function combineMemories(entries, summaries) {
  const ranked = [...entries].sort((a, b) => memoryPriority(b) - memoryPriority(a))
  if (memoryPriority(ranked[0])) {
    const primary = ranked[0].text.replace(/^(?:【[^】]+】)+/, '')
    const secondary = [...memoryTopic(ranked[1])].slice(0, 12).join('')
    const limit = secondary ? 59 - memoryLength(secondary) : 60
    const preview = [...primary].slice(0, limit).join('')
    return { id: entries[0].id, text: secondary ? preview + '；' + secondary : preview, sources: entries }
  }
  const scope = audience(entries[0].text)
  const sameAudience = entries.every(entry => JSON.stringify(audience(entry.text)) === JSON.stringify(scope))
  const summary = sameAudience && (scope === null || scope.length)
    ? summaries.get(entries.map(entry => entry.id).join('+')) : ''
  const combined = entries.map(entry => entry.text).join(' / ')
  const topics = entries.map(memoryTopic)
  const preview = topics.every(Boolean) ? topics.join(' / ') : ''
  const references = entries.map(entry => '#' + entry.id).join('、')
  return {
    id: entries[0].id,
    text: summary || (memoryLength(combined) <= 60 ? combined : '') ||
      (preview && memoryLength(preview) <= 60 ? preview : '合并记录（' + references + '）'),
    sources: entries
  }
}

function archiveDisplay(entries) {
  const olderCount = entries.length > 20 ? 1 + 4 * Math.ceil((entries.length - 20) / 4) : 0
  const older = entries.slice(0, olderCount)
  const visible = entries.slice(olderCount)
  if (older.length) {
    let overview = '早期概况（' + older.length + ' 份）：'
    const sources = older.flatMap(sourcesOf)
    const priority = [...sources].sort((a, b) => memoryPriority(b) - memoryPriority(a))[0]
    const topics = new Set([[...memoryTopic(priority)].slice(0, 40).join(''), ...sourcesOf(older.at(-1)).map(memoryTopic)])
    for (const topic of topics) {
      if (!topic || memoryLength(overview + topic) > 59) continue
      overview += topic + '；'
    }
    visible.unshift({ id: older[0].id, text: overview.endsWith('；') ? overview.slice(0, -1) : overview + '原始记录保留在存档' })
  }
  return ['当前档案数目：' + visible.length + (older.length ? '（原档案 ' + entries.length + ' 份）' : ''),
    ...visible.map((entry, index) => (index + 1) + '. ' + archiveText(entry))].join('\n')
}

export function updatePrismMemory(memory, panels, confirmedFacts = []) {
  const recent = [...memory.recent]
  const archive = new Map(memory.archive.map(entry => [entry.id, entry]))
  const known = new Set([...recent, ...memory.archive.flatMap(sourcesOf)].map(entry => normalizeMemory(entry.text)))
  const summaries = new Map()
  let nextId = memory.nextId

  function remember(text) {
    const key = normalizeMemory(text)
    if (known.has(key)) return
    known.add(key)
    recent.push({ id: nextId++, text })
  }
  for (const fact of confirmedFacts) remember(fact)

  for (const title of memoryTitles) {
    const panel = panels.find(item => item.title === title)
    if (!panel || panel.carried) continue
    for (const line of panel.text.split(/\r?\n/)) {
      const summary = /^\s*\[合并\s+(\d+)\s*\+\s*(\d+)\]\s*(\S.*)$/.exec(line)
      if (summary && title === memoryTitles[1] && memoryLength(summary[3].trim()) <= 40) {
        summaries.set(summary[1] + '+' + summary[2], summary[3].trim())
        continue
      }
      const match = /^\s*\[\d+\]\s*(\S.*)$/.exec(line)
      if (!match) continue
      remember(match[1].trim())
    }
  }

  while (recent.length > workingLimit) {
    const entries = recent.splice(0, 2)
    // Old saves can contain the same source both here and in the permanent archive.
    const pending = entries.filter(entry => !archive.has(entry.id))
    if (!pending.length) continue
    const entry = pending.length === 2 ? combineMemories(pending, summaries) : pending[0]
    archive.set(entry.id, entry)
  }
  const archived = [...archive.values()].sort((a, b) => a.id - b.id)
  return {
    memory: { recent, archive: archived, nextId },
    panels: panels.map(panel => {
      if (panel.title === memoryTitles[0]) return { ...panel, carried: false, text: ['当前记忆数目：' + recent.length + '/4', ...recent.map(archiveText)].join('\n') }
      if (panel.title === memoryTitles[1]) return { ...panel, carried: false, text: archiveDisplay(archived) }
      return panel
    })
  }
}

function memoryTerms(text, width = 2) {
  const terms = new Set()
  for (const run of text.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]/.test(run)) {
      if (run.length >= 3) terms.add(run)
      continue
    }
    for (let index = 0; index + width <= run.length; index++) terms.add(run.slice(index, index + width))
  }
  return terms
}

export function prismMemoryContext(memory, panels, action, scene, teammateNames) {
  const named = text => teammateNames.filter(name => text.includes(name))
  const actionNames = named(action)
  const active = actionNames.length ? actionNames : named(scene)
  const actionTerms = memoryTerms(action)
  const sceneTerms = memoryTerms(scene)
  const visible = entry => {
    const scope = audience(entry.text)
    return scope === null || (active.length > 0 && active.every(name => scope.includes(name)))
  }
  const score = entry => {
    const scope = audience(entry.text)
    const fact = entry.text.replace(/^(?:【[^】]+】)+/, '')
    const terms = [...memoryTerms(fact)]
    const actionHits = terms.filter(term => actionTerms.has(term)).length
    const sceneHits = terms.filter(term => sceneTerms.has(term)).length
    const actors = active.filter(name => fact.includes(name) || scope?.includes(name)).length
    if (!actors && actionHits < 2 && sceneHits < 3) return 0
    return actors * 8 + actionHits * 3 + Math.min(sceneHits, 6) + (entry.text.includes('【待办】') ? 5 : 0) + memoryPriority(entry)
  }
  const bounded = (entries, maxCount, maxChars, chronological = false) => {
    const result = []
    for (const entry of entries) {
      const line = archiveText(entry)
      const length = memoryLength(line) + 1
      if (length > maxChars) continue
      result.push(line)
      maxChars -= length
      if (result.length === maxCount) break
    }
    if (chronological) result.reverse()
    return result.join('\n') || '无可用条目。'
  }
  const archived = memory.archive.flatMap(sourcesOf)
  const recentIds = new Set(memory.recent.map(entry => entry.id))
  const relevant = archived.filter(entry => !recentIds.has(entry.id) && visible(entry))
    .map(entry => ({ entry, score: score(entry) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.id - a.entry.id).map(item => item.entry)
  const working = memory.recent.filter(visible)
  const sharedWords = new Set(['练习室', '录音室', '经纪人', '未确认', '未完成', '未提起', '未公开', '两个人', '两人约', '下一次', '已确认', '没有变', '练习生', '工作室', '已完成', ...teammateNames])
  const privateClues = new Set()
  for (const entry of [...memory.recent, ...archived]) {
    if (!audience(entry.text)?.length) continue
    const fact = entry.text.replace(/^(?:【[^】]+】)+/, '')
    for (const term of memoryTerms(fact, 3)) {
      if (!sharedWords.has(term) && !/^\d+$/.test(term)) privateClues.add(term)
    }
  }
  for (const entry of [...memory.recent, ...archived]) {
    if (audience(entry.text) !== null) continue
    for (const term of memoryTerms(entry.text, 3)) privateClues.delete(term)
  }
  // The model sometimes repeats private plans in schedule or relationship snapshots.
  const state = [...panels].filter(([title]) => !memoryTitles.includes(title)).map(([title, content]) => [title,
    content.split(/\r?\n|(?<=[；;])/).filter(part => ![...memoryTerms(part, 3)].some(term => privateClues.has(term))).join('\n')
  ])
  return [
    ...state,
    ['工作记忆', bounded([...working].reverse(), workingLimit, 600, true)],
    ['历史档案', bounded(relevant, 4, 720)]
  ]
}

// 【队友关系】面板里的好感数字以账本为准。
// 协议里写了「账本数值优先」，模型仍会照抄上一轮的面板数字（实测账本 30、面板 48、思维链 47→48），
// 所以渲染层逐行把「角色名 … 好感 N」里的数字换成账本值，并标注（账本）。
// 只用于显示：存的正文和面板原文都不动。
const numberSpan = '(\\d+(?:\\s*(?:→|➝|->|~|～|－|-|至|到)\\s*\\d+)?)'
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function alignAffectionText(text, members) {
  if (!text || !members || typeof members !== 'object') return text
  let out = text
  for (const [name, entry] of Object.entries(members)) {
    const target = entry && typeof entry === 'object' ? entry.affection : undefined
    if (name === '玩家' || !Number.isSafeInteger(target)) continue
    const pattern = new RegExp('(' + escapeRegExp(name) + '[^\\n]{0,12}?好感\\s*[：:]?\\s*)' + numberSpan, 'g')
    out = out.replace(pattern, (match, prefix, numbers) => {
      const parsed = numbers.match(/\d+/g) ?? []
      if (parsed.length === 1 && Number(parsed[0]) === target) return match
      return prefix + target + '（账本）'
    })
  }
  return out
}

export function withLedgerAffection(title, text, ledger) {
  if (title !== '队友关系' || !ledger) return text
  return alignAffectionText(text, ledger.members)
}

