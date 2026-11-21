import { mergePanelStats, panelStatsTitle, panelTitlesOf, prismArchivePriorityRule, prismChecks, prismMemoryContext, prismMemoryProtocol, prismPanels, splitChoices, splitPrismTurn, updatePrismMemory } from './lib/choices.mjs'
import { encodeOpening, parseOpening as decodeOpening, contextBudget, residentWithinBudget, requestRoster, projectLedger, projectPanelText, boundedJson, clipText, buildRosterIndex } from './lib/context.mjs'

const text = value => typeof value === 'string' && value.trim() !== ''
const key = value => typeof value === 'string' && /^[a-z0-9-]{1,60}$/i.test(value)
const stat = value => Number.isInteger(value) && value >= 0 && value <= 100
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const settingFields = { place: '地点', duration: '时长', rule: '规则' }
const choiceProtocol = '每轮叙事结束后，另起一行输出分隔符 ---CHOICES---，然后给出 3 个可选方向，每行一个，用 ①②③ 开头。'
const defaultChoiceInstruction = [
  choiceProtocol, '要求：', '- 每条不超过 40 字',
  '- 三种必须是实质不同的走向，不是同一动作的不同说法',
  '- 选项要让玩家能做决定，不要写成旁白',
  '结束时不要解释这些选项。'
].join('\n')

function check(condition, message) {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------------------
// turnPanels：每轮状态面板的声明方式。
//   "prism"                      → 沿用写死的 prismPanels 七段 + prismStats 账本（旧路径，一字不改）
//   { mode: "custom", protocol, panels, marker?, statsTitle? }
//                                → 由剧本自带字段清单与书写规则；PRISM 的七段不再注入
// ---------------------------------------------------------------------------

export function customPanelsOf(script) {
  const value = script?.turnPanels
  return value && typeof value === 'object' && value.mode === 'custom' ? value : null
}

function validateTurnPanels(value) {
  check(record(value) && value.mode === 'custom', 'turnPanels 只支持 "prism" 或 { mode: "custom", … }。')
  check(text(value.protocol) && [...value.protocol].length <= 9000, '自定义面板协议不能为空，且不超过 9000 字。')
  check(Array.isArray(value.panels) && value.panels.length >= 1 && value.panels.length <= 12 &&
    value.panels.every(title => text(title) && [...title].length <= 20 && !/[【】\r\n]/.test(title)) &&
    new Set(value.panels).size === value.panels.length, '自定义面板需要 1–12 个不重复的标题，标题里不能有【】或换行。')
  check(value.marker === undefined || (text(value.marker) && /^[A-Z][A-Z-]{0,20}$/.test(value.marker)), '面板分隔符须为 2–21 位大写英文或连字符。')
  check(value.statsTitle === undefined || (text(value.statsTitle) && /^[A-Z][A-Z-]{0,20}$/.test(value.statsTitle)), '面板账本分隔符须为 2–21 位大写英文或连字符。')
}

/** ── 世界书（按需加载）──
 *  剧本可带 worldBook: [{ key, value, tag }]，compile 时编进 opening 末尾一个区块；
 *  customRequest 每轮把它切掉、按当前对话匹配、只把命中的拼回 system。
 *  key 写法与风月一致：_or_甲@wb@乙 表示「甲或乙命中即激活」。
 */
export function splitWorldBook(content) {
  const text = typeof content === 'string' ? content : ''
  const m = /\n【世界书·按需加载】\n([\s\S]*?)\n【世界书结束】/.exec(text)
  if (!m) return { base: text, entries: [] }
  const base = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n')
  const entries = []
  const re = /<<WB\|([^|>]*)\|([^|>]*)>>\n([\s\S]*?)\n<<\/WB>>/g
  let x
  while ((x = re.exec(m[1]))) entries.push({ key: x[1], tag: x[2], value: x[3] })
  return { base, entries }
}

export function matchWorldBook(entries, text, opts) {
  const o = opts || {}
  const limit = o.limit ?? Infinity
  const maxChars = o.maxChars ?? 4200
  const alwaysTags = o.alwaysTags || []
  const score = source => entries.map((e, index) => {
    const words = String(e.key).split(/@wb@|_or_|_and_/).map(s => s.trim()).filter(Boolean)
    const hits = words.filter(w => String(source).includes(w)).length
    const n = alwaysTags.includes(e.tag) ? 999 : String(e.key).includes('_and_') && hits !== words.length ? 0 : hits
    const priority = e.tag === '角色' && o.priorityNames?.some(name => e.value.startsWith(name + '：')) ? 10000 : 0
    return { e, n: n > 0 ? n + priority : 0, index }
  }).filter(x => x.n > 0).sort((a,b) => b.n - a.n || a.index - b.index)
  const out = []
  const counts = new Map()
  let chars = 0
  const add = scored => {
    for (const { e } of scored) {
      if (out.length >= limit) break
      if (out.includes(e) || (counts.get(e.tag) ?? 0) >= (o.quotas?.[e.tag] ?? Infinity)) continue
      const size = ('【' + (e.tag || '设定') + '】\n' + e.value + '\n\n').length
      if (chars + size > maxChars) continue
      out.push(e)
      counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1)
      chars += size
    }
  }
  add(score(text || ''))
  // Only deepen into caller-provided recent context; never activate unrelated entries.
  if (chars < (o.minChars ?? 0) && o.fallbackText) add(score(o.fallbackText))
  return out
}

/** 从剧本的 turnPanels 得到解析配置；PRISM 剧本返回 null（走默认表）。 */
export function panelConfigOf(script) {
  const custom = customPanelsOf(script)
  if (!custom) return null
  return {
    titles: custom.panels.slice(),
    marker: custom.marker ?? 'PANEL',
    statsTitle: custom.statsTitle ?? 'PANEL-STATS'
  }
}

/** 编译产物里的【面板清单】行 → 标题数组。载入存档时不必回头读剧本。 */
export function panelTitlesFromOpening(opening) {
  const line = /^【面板清单】[ \t]*(.+?)(?:（[^）\r\n]*）)?[ \t]*\r?$/m.exec(typeof opening === 'string' ? opening : '')?.[1] ?? ''
  const titles = line.split(/[｜|]/).map(title => title.trim()).filter(Boolean)
  return titles.length ? titles : null
}

function customPanelBlock(custom, choices) {
  const config = panelConfigOf({ turnPanels: custom })
  const statsTitle = panelStatsTitle(config)
  // 只有剧本「自己」声明了 choiceInstruction（不等于引擎默认值）时才以剧本为准；
  // 否则追加引擎的默认三条（①②③）。两条相反的指令不能同时进 prompt。
  const ownChoiceRule = typeof choices === 'string' && choices !== defaultChoiceInstruction && choices.includes('---CHOICES---')
    ? choices.trim() : ''
  return [
    '', '【每轮输出协议】',
    ...custom.protocol.split(/\r?\n/).map(line => line.trimEnd()),
    '', '【面板清单】' + config.titles.join('｜') + '（每轮按此顺序各写一段，标题照抄，一段不漏，顺序不变）',
    '面板各部分紧跟在单独一行 ---' + config.marker + '--- 之后。面板写完后另起一行写 ---' + statsTitle
      + '---，下一行只写一个 JSON 对象（不写代码块、不写解释）。',
    ownChoiceRule || '最后另起一行写 ---CHOICES---，然后给出 3 条可执行的下一步，每行一条，用 ①②③ 开头。选项写清楚具体动作，不写旁白，不在选项里结算后果。',
    '第一轮也必须按同样顺序输出完整面板与 ' + statsTitle + '，开场白也算一轮。'
  ]
}

export function validateSetting(setting) {
  for (const [field, label] of Object.entries(settingFields)) {
    check(text(setting?.[field]), label + '不能为空。')
  }
  const policy = setting.castPolicy
  if (policy !== undefined) {
    check(record(policy), 'castPolicy 必须是对象。')
    check(policy.maxOnStage === undefined || (Number.isSafeInteger(policy.maxOnStage) && policy.maxOnStage > 0), 'maxOnStage 必须为正整数。')
    check(policy.contextBudgetChars === undefined || (Number.isSafeInteger(policy.contextBudgetChars) && policy.contextBudgetChars >= 2000), 'contextBudgetChars 必须是至少 2000 的整数。')
    check(policy.alwaysOnStage === undefined || (Array.isArray(policy.alwaysOnStage) && policy.alwaysOnStage.every(text) && new Set(policy.alwaysOnStage).size === policy.alwaysOnStage.length), 'alwaysOnStage 必须是不重复的姓名或 ID 数组。')
    check((policy.alwaysOnStage?.length ?? 0) <= (policy.maxOnStage ?? 8), '常驻角色数不能超过 maxOnStage。')
  }
}

export function validateRoutes(routes, roles) {
  check(Array.isArray(routes) && routes.length >= 2 && routes.every(record), '至少需要一条预设路线和一条自由路线。')
  check(routes.filter(route => route.custom === true).length === 1 && routes.at(-1).custom === true, '必须且只能有一条自由路线，且排在最后。')
  for (const route of routes) {
    check(key(route.id) && text(route.name), '路线缺少有效 ID 或名称。')
    check(route.custom === undefined || typeof route.custom === 'boolean', '路线的 custom 必须为布尔值。')
    check(route.random === undefined || (route.random === true && route.custom === true), '只有自由路线可以启用随机开局。')
    if (route.custom === true) continue
    check(text(route.scene), '每条预设路线都需要场景文字。')
    if (route.stats === undefined) route.stats = {}
    check(record(route.stats), '预设路线角色数值必须是对象。')
    for (const role of roles) {
      const values = Object.hasOwn(route.stats, role.id) ? route.stats[role.id] : undefined
      if (values === undefined) continue
      if (Array.isArray(values)) {
        route.stats[role.id] = Object.fromEntries(role.stats.map((item, index) =>
          [item.key, typeof values[index] === 'number' ? values[index] : item.default]))
      }
      const keyed = route.stats[role.id]
      check(record(keyed), '路线里角色 ' + role.id + ' 的数值必须是对象。')
      check(Object.keys(keyed).every(k => role.stats.some(s => s.key === k)), '路线中 ' + role.name + ' 存在未知数值键。')
      for (const item of role.stats) {
        if (!Object.hasOwn(keyed, item.key)) continue
        check(stat(keyed[item.key]), '路线中 ' + role.name + ' 的「' + item.key + '」须为 0–100 整数。')
      }
    }
    check(Object.keys(route.stats).every(id => roles.some(role => role.id === id)), '路线 ' + route.id + ' 存在不在角色表中的角色 ID。')
  }
  check(new Set(routes.map(route => route.id)).size === routes.length, '路线 ID 必须各不相同。')
  return routes
}

export function validateScript(script) {
  check(record(script) && key(script.id) && [script.title, script.subtitle, script.hint].every(text), '请填写有效的剧本 ID、标题、副标题和提示。')
  validateSetting(script.setting)
  check(Array.isArray(script.roles) && script.roles.length >= 1, '剧本至少需要 1 位角色。')
  for (const role of script.roles) {
    check(role && key(role.id) && text(role.name) && text(role.profile), '角色缺少有效 ID、名称或设定。')
    check(role.tier === undefined || ['cast', 'support', 'extra'].includes(role.tier), '角色 tier 只能是 cast / support / extra。')
    check(role.aliases === undefined || (Array.isArray(role.aliases) && role.aliases.every(text)), '角色别名必须是字符串数组。')
    check(role.where === undefined || typeof role.where === 'string', '角色 where 必须是字符串。')
    check(Array.isArray(role.stats) && role.stats.length <= 4 &&
      role.stats.every(item => item && text(item.key) && stat(item.default)), '每位角色最多 4 个数值，默认值须为 0–100 的整数。')
    check(new Set(role.stats.map(item => item.key)).size === role.stats.length, '同一角色的数值名称不能重复。')
  }
  check(new Set(script.roles.map(role => role.id)).size === script.roles.length, '角色 ID 必须各不相同。')
  for (const name of script.setting.castPolicy?.alwaysOnStage ?? []) check(script.roles.some(r => r.tier !== 'extra' && (r.id === name || r.name === name || r.aliases?.includes(name))), '常驻角色不存在或被标为 extra：' + name)
  const fields = script.playerFields
  check(Array.isArray(fields) && fields.every(field => field && typeof field.key === 'string' &&
    /^[a-z][a-z0-9_-]{0,59}$/i.test(field.key) && text(field.label) &&
    ['text', 'textarea'].includes(field.type) && (field.chips === undefined ||
    (Array.isArray(field.chips) && field.chips.every(text)))), '玩家字段需要有效键名、标签和控件类型。')
  check(new Set(fields.map(field => field.key)).size === fields.length, '玩家字段键名不能重复。')
  check(['label', 'optionTitle', 'optionDesc'].every(field => text(script.toggle?.[field])), '特殊设定缺少标题或说明。')
  validateRoutes(script.routes, script.roles)
  if (script.turnPanels !== undefined && script.turnPanels !== 'prism') validateTurnPanels(script.turnPanels)
  if (script.prismStats !== undefined) validatePrismSeed(script.prismStats, script.roles)
  if (script.fans !== undefined) validateFanProfiles(script.fans)
  script.choiceInstruction = text(script.choiceInstruction) ? script.choiceInstruction : defaultChoiceInstruction
  return script
}

export function createDraft(script, saved = {}) {
  let routes
  try {
    if (Array.isArray(saved?.routes)) routes = validateRoutes(structuredClone(saved.routes), script.roles)
  } catch {
    // Discard stale route edits when the source roles or stats have changed.
  }
  if (routes && script.routeVersion && saved?.routeVersion !== script.routeVersion) {
    const existing = new Map(routes.map(route => [route.id, route]))
    const defaults = script.routes.slice(0, -1)
    const ids = new Set(defaults.map(route => route.id))
    routes = [
      ...defaults.map(route => existing.get(route.id) ?? structuredClone(route)),
      ...routes.filter(route => !route.custom && !ids.has(route.id)),
      structuredClone(script.routes.at(-1))
    ]
  }
  const available = routes ?? script.routes
  const selected = available.find(route => route.id === saved?.routeId)
  const player = Object.fromEntries(script.playerFields.map(({ key: id }) => [
    id, typeof saved?.player?.[id] === 'string' ? saved.player[id] : ''
  ]))
  const setting = Object.fromEntries(Object.keys(settingFields).map(field => [
    field, typeof saved?.setting?.[field] === 'string' ? saved.setting[field] : script.setting[field]
  ]))
  if (script.setting.castPolicy) setting.castPolicy = structuredClone(script.setting.castPolicy)
  return {
    scriptId: script.id,
    selectedModel: typeof saved?.selectedModel === 'string' ? saved.selectedModel : '',
    player, setting, routes, routeVersion: script.routeVersion,
    toggleOn: saved?.toggleOn === true,
    routeId: selected?.id ?? (available.find(route => route.recommended) ?? available[0]).id,
    customScene: typeof saved?.customScene === 'string' ? saved.customScene : '',
    panelOpen: { world: saved?.panelOpen?.world === true, memory: saved?.panelOpen?.memory === true },
    summary: typeof saved?.summary?.text === 'string' ? { text: saved.summary.text } : undefined
  }
}

const randomOpenings = [
  '临时录音间：外请制作人只留十分钟，要听一段之前没交过的小样。',
  '签售散场后：工作人员拾到一封署名存疑的信，只找到你可以核对交接记录。',
  '拍摄棚换景时：节目组临时取消一个环节，经纪人要两位成员在上镜前决定由谁接棒。',
  '回宿舍的保姆车上：队友私下请你帮她核对一份排练录音，车里还有不知情的人。',
  '凌晨便利店：一位刚结束通告的队友认出你，提到第二天采访的问题清单被临时更换。',
  '舞台音响联调：监听里出现一段不在正式脚本上的伴奏，只有一次机会确认是谁改的。'
]

export function compile(script, draft, { random } = {}) {
  const { player, toggleOn, customScene = '' } = draft
  const setting = draft.setting ?? script.setting
  validateSetting(setting)
  const routes = draft.routes ?? script.routes
  const route = routes.find(item => item.id === draft.routeId) ?? routes[0]
  const scene = route.random ? [
    random ? '本局抽到的开场线索：' + randomOpenings[Math.floor(random() * randomOpenings.length)] : '点击「开始游戏」时抽取本局的场景和冲突。',
    ...(customScene.trim() ? ['玩家提供的可选方向：' + customScene.trim()] : []),
    '以线索为起点创作全新第一幕，结合玩家档案和一至三位团员展开。明确时间、地点和眼前利害，停在第一个玩家可以决定的节点。已有账本初值沿用，未发生的行动或私事不要提前结算。'
  ] : route.custom ? [customScene, 'AI 将根据以上设定自动推演角色的反应与初始数值。'] : [route.scene]
  const value = input => input?.trim() || '未填写'
  const paired = Object.hasOwn(player, 'age') && Object.hasOwn(player, 'job')
  const ageAndJob = paired ? [player.age, player.job].map(item => item.trim()).filter(Boolean).join(' · ') : ''
  const profile = script.playerFields.flatMap(field => {
    if (paired && field.key === 'job') return []
    if (paired && field.key === 'age') return ['- 年龄与职业：' + value(ageAndJob)]
    return ['- ' + field.label + '：' + value(player[field.key])]
  })
  // 星级 → 价格：引擎算好写成一行，模型直接抄，不许自己乘。
  const starOf = k => {
    const n = parseInt(String(player[k] == null ? '' : player[k]).replace(/[^\d]/g, ''), 10)
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 0
  }
  const sx = ['star_look', 'star_body', 'star_clean', 'star_sex'].map(starOf)
  const starTotal = sx.reduce((a, b) => a + b, 0)
  const playStar = starOf('star_play') || 1
  const MULT = { 1: 1, 2: 1.25, 3: 2.5, 4: 10, 5: 100 }
  const mult = MULT[playStar] || 1
  const priceLine = starTotal >= 4
    ? '- 你的价（引擎已算好，直接照抄，不许自己乘）：容 ' + sx[0] + '｜身 ' + sx[1] + '｜净 ' + sx[2] + '｜阴或阳 ' + sx[3] + ' ＝ ' + starTotal + ' 星。基础包夜 ' + (starTotal * 1000) + '｜标准两小时 ' + (starTotal * 500) + '。你接 ' + playStar + ' 星玩法（×' + mult + '）：本场两小时 ' + (starTotal * 500 * mult) + '｜包夜 ' + (starTotal * 1000 * mult) + '。玩法星级只乘在「本场实收」上，基础包夜那两行照抄不动。'
    : '- 你的价：星级没填，按门厅最低 4 星算（基础包夜 4000｜两小时 2000）。'
  const auctionLine = starTotal >= 4
    ? '- 你上拍卖台的起拍价（引擎算好，直接照抄）：一晚 ' + (starTotal * 3000) + '｜一月 ' + (starTotal * 30000) + '｜买断 ' + (starTotal * 300000) + '。起拍价是地板，抬多少算多少；指定五星玩法再乘 100。'
    : ''

  const stats = script.roles.map(role => role.stats.map(item =>
    role.name + '·' + item.key + '：' + (route.custom === true ? item.default : route.stats?.[role.id]?.[item.key] ?? item.default)).join(' | '))
  const choices = script.choiceInstruction?.trim() || defaultChoiceInstruction
  const custom = customPanelsOf(script)
  // 叙述尺度：剧本可以在 style.scale 里声明本篇的情色/暴力书写标准，缺省则整段不出现。
  const scale = typeof script.style?.scale === 'string' ? script.style.scale.trim() : ''
  return encodeOpening([
    '【剧本与世界观】', script.title + ' · ' + script.subtitle, script.hint,
    '地点：' + setting.place, '时长：' + setting.duration, '规则：' + setting.rule,
    '', '【角色设定】', ...script.roles.map(role => role.name + '：' + role.profile),
    '', '【玩家自定义档案】', ...profile,
    ...(script.playerFields.some(f => f.key === 'star_look') ? [priceLine, auctionLine].filter(Boolean) : []),
    '- 特殊设定：' + (toggleOn ? script.toggle.optionDesc : (script.toggle.offText || '无')),
    '', '【开局初始数值】', ...(route.custom && !route.random ? ['以下是默认参考值，实际初值请按自定义开场推演。'] : []), ...stats,
    '', '【开局场景：' + route.name + '】',
    ...scene,
    ...(scale ? ['', '【叙述尺度 · 硬性要求】', scale] : []),
    ...(script.turnPanels === 'prism' ? [
      '', '【PRISM 每轮状态协议】',
      '先写本轮剧情，在玩家需要决定时停下。涉及公众反应时，写出至少三条帖子或评论，每条用【用户ID】：内容，账号名和说话方式各有区别，可写互相回复或争论。只有发生明确传播时才写公众反应。',
      ...prismContinuityRules(script.fans ?? []),
      ...relationshipEventRules,
      ...publicSupportRules,
      '正文后另起一行写 ---THINK---，输出可展示的剧情检查摘要。只列本轮结果及可核对的事实，每项一句，不展开内部推理。按以下顺序逐行编号：',
      ...prismChecks.map(([title, detail], index) => (index + 1) + '. ' + title + '：' + detail),
      '摘要后另起一行写 ---PRISM---，按下列顺序输出完整快照。每个标题用【标题】独立成行，下一行写内容，不使用 HTML 或代码块。',
      ...prismPanels.map(([title, description]) => '【' + title + '】' + ' — ' + description),
      '【队友关系】里的好感数字必须逐字等于「开局/续局基准里该成员的 affection 值 + 本轮 PRISM-STATS 里提交的变化量」。不许自己推算、不许沿用旧面板里的数字、不许写成区间或带箭头。写不出确定的数就照抄基准值。',
      ...prismMemoryProtocol,
      prismArchivePriorityRule,
      '当前情况面板的信息传播情况须和检查摘要一致。区分玩家内心、在场角色目击和经渠道公开的消息。角色仅使用自身已知信息。',
      ...(script.prismStats ? [
        '人气、唯粉、玩家路人缘、玩家 CP 粉和组合热度与粉丝数由本地账本展示。成员状态和 CP 面板的文字只写处境与变动理由，避免重复这些数值。',
        '在行动推荐之前另起一行写【PRISM-STATS】，下一行只写 JSON 对象，禁止代码块。day 是剧情日序号，第一天为 1，每轮按场景日期判断，睡到次日、明确次日或时间跳跃至次日时加 1。同日保持原值。不要因人气达到上限而跳日。当前情况所写日期必须与 day 同步。members 按账本键名，玩家固定用「玩家」。pairs 按 CP 名。值是变动后的绝对整数，只提交有剧情依据的变动，未变项省略。成员可更新 affection（好感）、trust（信任）、suspicion（怀疑），均为 0–100 整数。',
        '格式示例（数字仅示例）：{"day":1,"members":{"玩家":{"popularity":860,"soloFans":1210,"passers":13,"cpFans":2},"陆星晚":{"affection":22,"affectionReason":"一起核对了副歌走位"}},"pairs":{"柔晚":{"heat":8200,"fans":45000}}}。无数值变动可只写 {"day":1}。'
      ] : []),
      '以上一轮快照为基准，只根据已发生的行动和事件更新。无变化的数值照抄并注明不变。私下互动只影响有关人物，除非出现明确传播途径，不改变公众数据。人气每日累计净变动不超过 ±100，好感每次变化不超过 ±10，CP 热度不等额转为人气。按剧情时钟推进，避免重复结算。保留仍有影响的承诺和事件。用玩家档案指定的人称，缺省用第二人称。',
      ...(script.prismStats ? ['开局账本种子：' + JSON.stringify(script.prismStats)] : []),
      '第一轮也必须按同样的顺序输出完整检查摘要和 ---PRISM--- 面板，开场白也算一轮。',
      ...(script.prismStats ? ['第一轮必须含【PRISM-STATS】和下一行合法 JSON，无变动也写 {"day":1}。'] : []),
      '最后另起一行写 ---CHOICES---，给出五条可执行的下一步，每条单独一行。每条须带一个分类前缀：【排练】【社交】【个人】【查看】【剧情特殊】【休息】【工作】。选择前不结算后果。',
    ] : custom ? customPanelBlock(custom, choices) : [
    '', '【状态栏协议】',
    '每一次回复的开头都输出以下两行状态栏，再推进叙事。按剧情更新日期、地点、进度和角色数值。数值为 0–100 的叙事参考。',
    '🕯 第 [N] 天 · [时段] | 📍 [地点] | 🌫 气氛：[一句话环境描写]',
    '🔑 [当前剧情进度，一句话]',
    '', '（请严格读取以上玩家档案、特殊设定与初始数值，同步至状态栏面板，并顺着上述开局场景直接开始第一轮叙事。）',
    '', '【每轮输出格式】', ...(choices.includes('---CHOICES---') ? [choices] : [choiceProtocol, choices])
    ])
,
    ...(Array.isArray(script.worldBook) && script.worldBook.length ? [
      '', '【世界书·按需加载】',
      ...script.worldBook.map(e => '<<WB|' + String(e.key).replace(/[|>]/g, '') + '|' + String(e.tag || e.group || '').replace(/[|>]/g, '') + '>>\n' + e.value + '\n<</WB>>'),
      '【世界书结束】'
    ] : []),
  ].join('\n'), script, draft)
}





const memberLimits = { popularity: 10000, soloFans: Number.MAX_SAFE_INTEGER, passers: 100, cpFans: Number.MAX_SAFE_INTEGER }
const relationshipLimits = { affection: 100, trust: 100, suspicion: 100 }
const pairLimits = { heat: 10000, fans: Number.MAX_SAFE_INTEGER }


function validatePrismSeed(seed, roles) {
  check(record(seed?.members) && record(seed?.pairs), 'PRISM 账本缺少成员或 CP 数据。')
  const valid = (entry, fields) => record(entry) && fields.every(([key, max]) =>
    Number.isSafeInteger(entry[key]) && entry[key] >= 0 && entry[key] <= max)
  const [popularity, soloFans] = Object.entries(memberLimits)
  check(roles.every(role => Object.hasOwn(seed.members, role.name) &&
    valid(seed.members[role.name], [popularity, soloFans])), 'PRISM 每位队友需要有效的人气和唯粉数。')
  check(valid(seed.members['玩家'], Object.entries(memberLimits)), 'PRISM 玩家账本数值无效。')
  check(Object.values(seed.pairs).every(entry => valid(entry, Object.entries(pairLimits))), 'PRISM CP 账本数值无效。')
}

const fanPlatforms = ['微博', '小红书', 'CP超话', 'B站', '抖音']
const fanLimit = 24

function validFan(fan) {
  return record(fan) && text(fan.id) && fan.id.length <= 30 && !/[【】\r\n]/.test(fan.id) &&
    fan.id === fan.id.trim() && !/^(?:路人|粉丝|网友|用户)[A-Z0-9甲乙丙丁]+$/iu.test(fan.id.trim()) &&
    fanPlatforms.includes(fan.platform) &&
    ['camp', 'stance', 'tone'].every(field => text(fan[field]) && fan[field].length <= 120)
}

function validateFanProfiles(fans) {
  check(Array.isArray(fans) && fans.length <= fanLimit && fans.every(validFan) &&
    new Set(fans.map(fan => fan.id)).size === fans.length, '粉丝角色库无效。')
}

function prismContinuityRules(fans) {
  const affection = [
    '【好感度规则】',
    '日常正面互动 +1～3，明确触发好感点 +4～6，重大恩情 +7～10。轻微冒犯 -1～2，当众打脸 -3～5，背叛或实质伤害 -6～10。没有明确触发点则不变。一次冷淡不能清空已建立的关系。',
    '每个变动在队友关系面板写明角色和触发点，并在对应 members 项里用 affectionReason 写同一事件。affection 写变化后的绝对值，本地每轮最多 ±10，范围 0～100。'
  ]
  if (!fans.length) return affection
  return [...affection,
    '【粉丝角色库】',
    ...fans.map(fan => '【' + fan.id + '】' + fan.platform + ' / ' + fan.camp + ' / ' + fan.stance + ' / ' + fan.tone),
    '【粉圈发言规则】',
    '当玩家主动查看已发布的内容或评论，必须在本轮正文直接展示评论，完成查看后再停在新的选择点。有公开事件时优先复用账本中的固定账号。每个事件至少呈现三个不同阵营的声音。格式为「【平台】【用户ID】：发言」并单独成行。阵营和平台保持一致，后续发言要记得此前公开发过什么，态度变化要有公开事件作为转折。禁止路人A等占位账号。',
    '确有必要才新增账号。正文须实际出现该账号的发言，在 CP 面板加「本轮新增粉丝」一行，并在账本 JSON 的 newFans 数组提供 id、platform、camp、stance、tone。后续沿用已入账账号。',
    '平台语气分别处理。微博短句和话题，小红书偏个人观演经历，CP超话偏时间线和截图，B站偏剪辑标题和弹幕，抖音聚焦具体画面和评论。未公开的互动不生成粉丝发言。'
  ]
}

export function startLedger(seed, fans = []) {
  return {
    ...structuredClone(seed),
    day: 1,
    dayStart: {},
    ...(fans.length ? { fandom: { profiles: structuredClone(fans), posts: [] } } : {})
  }
}

function updateValues(target, patch, limits) {
  if (!record(patch)) return
  for (const [key, max] of Object.entries(limits)) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (Object.hasOwn(target, key) && Number.isSafeInteger(value) && value >= 0 && value <= max) {
      target[key] = value
    }
  }
}

const fanPost = /^([ \t]*)【([^】\r\n]+)】[ \t]*【([^】\r\n]+)】[：:][ \t]*(\S[^\r\n]*)/gm

export function normalizeFanPlatforms(narrative, fandom) {
  if (!fandom) return narrative
  const platforms = new Map(fandom.profiles.map(fan => [fan.id, fan.platform]))
  return narrative.replace(fanPost, (line, indent, platform, id, content) => {
    const assigned = platforms.get(id)
    return assigned && assigned !== platform ? indent + '【' + assigned + '】【' + id + '】：' + content : line
  })
}

function recordFanPosts(fandom, candidates, narrative) {
  const known = new Map(fandom.profiles.map(fan => [fan.id, fan]))
  const posts = [...narrative.matchAll(fanPost)]
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (known.size >= fanLimit) break
    if (validFan(candidate) && !known.has(candidate.id) &&
      posts.some(([,, platform, id]) => id === candidate.id && platform === candidate.platform)) {
      const { id, platform, camp, stance, tone } = candidate
      const fan = { id, platform, camp, stance, tone }
      known.set(id, fan)
      fandom.profiles.push(fan)
    }
  }
  for (const [,, platform, id, raw] of posts) {
    if (known.get(id)?.platform !== platform) continue
    const content = raw.trim().slice(0, 180)
    if (fandom.posts.some(post => post.id === id && post.content === content)) continue
    const previous = fandom.posts.filter(post => post.id === id)
    if (previous.length >= 2) fandom.posts.splice(fandom.posts.indexOf(previous[0]), 1)
    fandom.posts.push({ id, content })
  }
}

const relationshipEvents = new Map([
  ['first-kiss', { label: '首次接吻', min: 5, max: 8 }],
  ['first-intimacy', { label: '首次亲密关系', min: 5, max: 8 }],
  ['public-support', { label: '首次公开支持', min: 3, max: 5 }],
  ['rupture', { label: '首次背叛或决裂', min: -10, max: -6 }],
  ['cost', { label: '付出明确代价', min: 4, max: 6 }]
])
const relationshipEventRules = [
  '【关系事件强制结算】本轮真实发生的首次双方自愿接吻、首次双方自愿建立亲密关系、首次公开支持、首次背叛或决裂、为对方付出明确代价，都是独立触发点。第 3 项剧情检查先写事件，再写数值；余波、提议、回忆及已结算的首次事件不重复提交。',
  'PRISM-STATS 的 relationshipEvents 数组每位队友最多一项。字段为 name（账本姓名）、type（first-kiss、first-intimacy、public-support、rupture 或 cost）、fact（客观结果一句）、evidence（本轮正文里连续的原句片段，直接写出队友姓名或引用正文已署名的发言）、public（仅已公开时为 true，可省略）、witnesses（私下额外知情队友的姓名，可省略）。本轮没有则省略。事实不要描写过程。照常在 members 提交绝对好感值和同一事件的 affectionReason。',
  '首次接吻和首次亲密关系 +5～8，首次公开支持 +3～5，首次背叛或决裂 -6～10，付出明确代价 +4～6。若同轮同一人有多个触发点，提交影响最大的一项。'
]
const publicSupportRules = [
  '【公开支持补充】公开支持包括当众为玩家说话、当众承认与玩家的约定或关系、当众把资源或镜头让给玩家。实际当众表态并被第三方听见时，首次须按 public-support 结算 +3～5，并提交 relationshipEvents。',
  '提前公开、兑现已有约定或关系阶段尚未改变，都不能抵消这次公开表态。只结算第一次，之后复述、回忆或已经结算的同类事件不重复计分。evidence 只摘一处原文，保留原来的引号，不额外加姓名前缀或拼接其他台词。'
]
const witnessedStatement = /当着[^。！？\r\n]{1,16}的面|当众(?:承认|宣布|确认|表态|支持)|(?:整个|全场|在场的人)[^。！？\r\n]{0,6}都听见|所有人都在看|全场安静/

function hasRelationshipEvidence(body, evidence, name, members) {
  if (!text(evidence) || evidence.length > 180 || /回忆|想起|并未|还没|打算|幻想/.test(evidence) ||
    /^[「“\s]*(?:假如|如果|倘若)/.test(evidence)) return false
  let index = body.indexOf(evidence)
  let evidenceEnd = index + evidence.length
  const quoted = /^[「“]([^」”\r\n]+)[」”]$/.exec(evidence)
  if (index < 0 && quoted) {
    const quote = quoted[1].replace(/[。！？!?]+$/, '')
    const start = body.indexOf(quote)
    const ending = /^[。！？!?]*[」”]/.exec(body.slice(start + quote.length))
    if (quote.length >= 5 && start > 0 && /[「“]/.test(body[start - 1]) && ending) {
      index = start - 1
      evidenceEnd = start + quote.length + ending[0].length
    }
  }
  if (index < 0) {
    // A model may format a real quote as “Name: quote / next quote”.
    const attribution = evidence.startsWith(name) ? evidence.slice(name.length).match(/^[：:]\s*[「“]([^」”\r\n]{5,})[」”]/) : null
    if (attribution) {
      const quote = attribution[1]
      return hasRelationshipEvidence(body, '「' + quote + '」', name, members) ||
        hasRelationshipEvidence(body, '“' + quote + '”', name, members)
    }
    const excerpts = evidence.split(/…+|\.{3,}/).map(part => part.trim())
    if (excerpts.length < 2 || excerpts.length > 3 || excerpts.some(part => part.length < 4)) return false
    index = body.indexOf(excerpts[0])
    if (index < 0) return false
    let end = index + excerpts[0].length
    for (const excerpt of excerpts.slice(1)) {
      const next = body.indexOf(excerpt, end)
      if (next < 0 || next - end > 240) return false
      end = next + excerpt.length
    }
    evidenceEnd = end
  }
  if (evidence.includes(name)) return true
  if (!/^[「“]/.test(evidence)) return false
  const context = body.slice(Math.max(0, index - 480), index)
  const lastMention = Object.keys(members).filter(member => member !== '玩家')
    .map(member => [member, context.lastIndexOf(member)]).sort((a, b) => b[1] - a[1])[0]
  const after = body.slice(evidenceEnd).trimStart().replace(/^[，,。]\s*/, '')
  return (lastMention?.[0] === name && lastMention[1] >= 0) ||
    (after.startsWith(name) && /^(?:说|道|开口|补充|接话|重复|回答)/.test(after.slice(name.length)))
}

function newRelationshipEvents(ledger, memory, stats, body) {
  const submitted = Array.isArray(stats?.relationshipEvents) ? stats.relationshipEvents : []
  const events = new Map()
  const repeated = new Set()
  for (const event of submitted.slice(0, 12)) {
    const rule = relationshipEvents.get(event?.type)
    if (!rule || typeof event.name !== 'string' || event.name === '玩家' ||
      !Object.hasOwn(ledger.members, event.name) || events.has(event.name)) continue
    const id = event.type === 'cost' ? undefined : event.type + ':' + event.name
    if (id && ledger.milestones?.includes(id)) {
      repeated.add(event.name)
      continue
    }
    if (!text(event.fact) || event.fact.length > 140 || /[\r\n【】]/.test(event.fact) ||
      !hasRelationshipEvidence(body, event.evidence, event.name, ledger.members)) continue
    const witnesses = Array.isArray(event.witnesses) ? event.witnesses.filter(name =>
      typeof name === 'string' && Object.hasOwn(ledger.members, name)) : []
    const scope = event.public === true ? '【公开】' : '【知情：' + [...new Set(['玩家', event.name, ...witnesses])].join('、') + '】'
    const fact = event.name + ' · ' + rule.label + '：' + event.fact.trim()
    if (!id && [...memory.recent, ...memory.archive.flatMap(entry => entry.sources ?? [entry])]
      .some(entry => entry.text.split('【里程碑】')[1] === fact)) {
      repeated.add(event.name)
      continue
    }
    events.set(event.name, { id, fact, scope, ...rule })
  }
  return { events, repeated }
}

export function updateLedger(current, patch, narrative = '', { events = new Map(), repeated = new Set() } = {}) {
  // 只钳制 day，不丢弃整包：模型常见「账本 day=3、叙事已到 11/16、每轮写 +2」，
  // 旧代码把 day 越界当成整包作废，members 里的人气和好感陪葬，账本从此再也不动。
  if (!record(patch) || !Number.isSafeInteger(patch.day)) return current
  const targetDay = Math.max(current.day, Math.min(patch.day, current.day + 1))
  const next = structuredClone(current)
  next.affectionChanges = []
  if (targetDay > current.day) {
    next.day = targetDay
    next.dayStart = {}
  }
  for (const [name, entry] of Object.entries(next.members)) {
    const member = Object.hasOwn(patch.members ?? {}, name) ? patch.members[name] : null
    const event = events.get(name)
    if (!record(member) && !event) continue
    let proposed = record(member) ? member : {}
    if (event) {
      const old = entry.affection ?? 20
      const delta = Number.isSafeInteger(proposed.affection) ? proposed.affection - old : 0
      const amount = delta >= event.min && delta <= event.max ? delta : (event.min > 0 ? event.min : event.max)
      proposed = { ...proposed, affection: Math.max(0, Math.min(100, old + amount)), affectionReason: event.fact }
      if (event.id) (next.milestones ??= []).push(event.id)
    }
    const baseline = Object.hasOwn(next.dayStart, name) ? next.dayStart[name] : entry.popularity
    next.dayStart[name] = baseline
    updateValues(entry, proposed, memberLimits)
    for (const [key, max] of Object.entries(relationshipLimits)) {
      const value = proposed[key]
      if (!Object.hasOwn(proposed, key) || !Number.isSafeInteger(value) || value < 0 || value > max) continue
      if (key !== 'affection') {
        entry[key] = value
        continue
      }
      if (repeated.has(name) && !event) continue
      const reason = proposed.affectionReason
      if (!text(reason) || /^(?:无|无变化|无原因|未知)[。！!\s]*$/.test(reason.trim())) continue
      const old = entry.affection ?? 20
      entry.affection = Math.max(old - 10, Math.min(old + 10, value))
      if (entry.affection !== old) next.affectionChanges.push({ name, delta: entry.affection - old, reason: reason.trim().slice(0, 180) })
    }
    entry.popularity = Math.max(baseline - 100, Math.min(baseline + 100, entry.popularity))
  }
  for (const [name, entry] of Object.entries(next.pairs)) {
    if (Object.hasOwn(patch.pairs ?? {}, name)) updateValues(entry, patch.pairs[name], pairLimits)
  }
  if (next.fandom) recordFanPosts(next.fandom, patch.newFans, narrative)
  return next
}

export function settlePrismTurn(memory, ledger, reply) {
  const { body, stats, panels } = reply
  const relationships = ledger ? newRelationshipEvents(ledger, memory, stats, body) : { events: new Map(), repeated: new Set() }
  const { events, repeated } = relationships
  // day 缺失才回落到当前剧情日；day 越界交给 updateLedger 钳制，members 必须照常落地。
  // 整轮没有 PRISM-STATS（stats 为空）仍旧原样传下去，由 updateLedger 判无账本可结。
  const dayMissing = !Number.isSafeInteger(stats?.day)
  const invalidDay = events.size > 0 && dayMissing
  const patch = record(stats) && dayMissing ? { ...stats, day: ledger.day } : stats
  const updated = ledger && updateLedger(ledger, patch, body, relationships)
  const facts = [...events.values()].map(event => event.scope + '【里程碑】' + event.fact)
  const result = updatePrismMemory(memory, panels, facts)
  const warnings = []
  if ((!Array.isArray(stats?.relationshipEvents) || stats.relationshipEvents.length === 0) && witnessedStatement.test(body)) {
    warnings.push('[关系结算漏检] 本轮出现公开表态描写，但未提交 relationshipEvents。')
  }
  if (ledger) {
    const sentences = body.split(/[。！？\r\n]/)
    for (const [name, member] of Object.entries(ledger.members)) {
      if (name === '玩家') continue
      const event = events.get(name)
      const before = member.affection ?? 20
      const after = updated.members[name].affection ?? 20
      if (event) {
        if (invalidDay) warnings.push(name + ' 的关系事件缺少有效日期，已按当前剧情日补结算。')
        else if (before === after) warnings.push(name + ' 的好感已达边界，本轮关系事件已记录。')
        else if (stats.members?.[name]?.affection !== after) warnings.push(name + ' 的好感提案缺失或不符，已按本轮关系事件补结算。')
      } else if (!repeated.has(name) && before === after && sentences.some(sentence => sentence.includes(name) &&
        /(?:第一次|首次).{0,18}(?:接吻|亲吻|亲密)|初吻|决裂|背叛/.test(sentence) &&
        !/回忆|想起|如果|并未|没有|还没|打算|想要|幻想/.test(sentence))) {
        warnings.push(name + ' 疑似发生新的关系转折，但好感未变化，请核对本轮剧情。')
      }
    }
  }
  const nextLedger = updated === ledger && updated?.affectionChanges?.length ? { ...updated, affectionChanges: [] } : updated
  return { ...result, ledger: nextLedger, warnings, ledgerApplied: updated !== ledger && !invalidDay }
}

const prismSkeleton = [
  '【每轮输出骨架】',
  '先写正文，再按以下顺序输出。每个分隔符和标题单独一行，括号里的说明换成实际内容。必须以五条分类选项收尾。',
  '---THINK---',
  ...prismChecks.map(([title], index) => (index + 1) + '. ' + title + '：（本轮事实）'),
  '---PRISM---',
  ...prismPanels.flatMap(([title]) => ['【' + title + '】', '（本轮状态）']),
  '【PRISM-STATS】',
  '（单行 JSON，day 必填并以当前账本为准）',
  '---CHOICES---',
  '【排练】（具体行动一）',
  '【社交】（具体行动二）',
  '【查看】（具体行动三）',
  '【工作】（具体行动四）',
  '【休息】（具体行动五）'
].join('\n')

export function prismRequest(messages, panels, ledger, memory, roster) {
  const [opening, ...turns] = messages
  const { dayStart, fandom, milestones, affectionChanges, ...confirmed } = ledger ?? {}
  const action = turns.at(-1)?.role === 'user' ? turns.at(-1).content : ''
  const previousReply = turns.findLast(message => message.role === 'assistant')
  const scene = previousReply ? splitPrismTurn(previousReply.content).body.slice(-1200) : ''
  let currentPanels = panels
  if (memory) {
    const roles = /【角色设定】\r?\n([\s\S]*?)\r?\n【玩家自定义档案】/.exec(opening.content)?.[1] ?? ''
    const names = ledger ? Object.keys(ledger.members).filter(name => name !== '玩家')
      : [...roles.matchAll(/^([^：\n]+)：/gm)].map(match => match[1])
    currentPanels = prismMemoryContext(memory, panels, action, scene, names)
  }
  const facts = [...currentPanels].map(([title, value]) => '【' + title + '】\n' + value).join('\n\n')
  const openingRules = opening.content.replace(/^工作记忆与历史档案各自逐行写新增事实[^\r\n]*\r?\n/m, '')
  const continuity = openingRules.includes('【粉圈发言规则】')
    ? [] : prismContinuityRules(fandom?.profiles ?? [])
  const fandomContext = fandom
    ? ['【当前粉丝档案】', JSON.stringify(fandom), '已有发言是公开历史，请在相关新事件中复用这些账号和前情。']
    : []
  const memoryRules = openingRules.includes('【记忆规则】') ? [] : prismMemoryProtocol
  const eventRules = [
    ...(openingRules.includes('【关系事件强制结算】') ? [] : relationshipEventRules),
    ...(openingRules.includes('【公开支持补充】') ? [] : publicSupportRules),
    ...(openingRules.includes('【归档优先级】') ? [] : [prismArchivePriorityRule])
  ]
  const system = openingRules + '\n\n【续局基准】\n以下是当前账本和最新面板。账本中的数值优先于旧剧情或面板里的数字。开局事件只在首轮使用，后续接续最近剧情。\n' +
    JSON.stringify(confirmed) + (facts ? '\n\n' + facts : '') + '\n\n' + [...continuity, ...fandomContext, ...memoryRules, ...eventRules, prismSkeleton].join('\n')
  const window = turns.slice(-12)
  let completeReplies = 0
  const recent = window.reverse().map(message => {
    if (message.role !== 'assistant') return message
    const reply = splitPrismTurn(message.content)
    return { role: message.role, content: !memory && completeReplies++ < 2 ? reply.context : reply.body }
  }).reverse()
  if (opening.content.includes('【引擎上下文v2】')) {
    const request = customRequest(turns, currentPanels, confirmed, null,
      openingRules + '\n' + [...continuity, ...fandomContext, ...memoryRules, ...eventRules, prismSkeleton].join('\n'), roster)
    // Keep PRISM's existing two-snapshot fallback when its memory engine is absent.
    if (recent.length) request.splice(1, request.length - 1, ...recent)
    return request
  }
  return [{ role: 'system', content: system }, ...(recent.length ? recent : [{ role: 'user', content: '按开局场景开始第一轮。' }])]
}

/**
 * 自定义面板剧本的一轮请求：最近对话保留正文（剥掉面板尾巴），把上一轮面板原文与本地面板数值
 * 拼进 system，再挂一张【续局基准】。新版 PRISM 复用预算渲染，旧版保留原请求路径。
 */
export const parseOpening = opening => decodeOpening(opening, splitWorldBook)
export const compileParts = (script, draft, options) => parseOpening(compile(script, draft, options))

export function prepareRequestRoster(opening, messages, previous = [], panels = new Map(), previousLocation) {
  const parts = parseOpening(opening)
  const list = panels instanceof Map ? [...panels] : panels ?? []
  const scene = list.filter(([title]) => /当前情况|场景|基础信息/.test(title)).map(([,v]) => v).join('\n')
  const location = /(?:地点|位置)[：:]\s*([^\n|｜]+)/.exec(scene)?.[1]?.replace(/\*\*/g, '').trim() || parts.location
  const input = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
  // Old scripts lack where: recover explicit presence from their saved panels before seeding the opening.
  const presence = list.filter(([title]) => /在场|当前交互|交互面板/.test(title)).map(([,v]) => v).join('\n')
  const recovered = !previous.length ? parts.roles.filter(r => r.tier !== 'extra' && !r.where && presence.includes(r.name)).map(r => ({ id: r.id, remote: false })) : previous
  return { parts, location, roster: requestRoster(parts, recovered, input, location, previousLocation ?? location) }
}

export function customRequest(messages, panels, panelState, config = null, opening, roster) {
  const hasExternal = typeof opening === 'string' && opening.length > 0
  const openingText = hasExternal ? opening : (typeof messages[0]?.content === 'string' ? messages[0].content : '')
  const turns = hasExternal ? messages.slice() : messages.slice(1)
  const parts = parseOpening(openingText)
  const budget = contextBudget(parts)
  const active = roster ?? prepareRequestRoster(openingText, turns, [], panels).roster
  const recent = turns.slice(-12).map(message => (message.role === 'assistant'
    ? { role: 'assistant', content: splitPrismTurn(message.content, new Map(), config).body }
    : message))
  const list = panels instanceof Map ? [...panels] : Array.isArray(panels) ? panels : []
  const panelText = list.length ? list.map(([title, value]) => '【' + title + '】\n' + projectPanelText(value, parts, active)).join('\n\n') : ''
  const stateJson = record(panelState) && Object.keys(panelState).length ? boundedJson(projectLedger(panelState, parts, active), Math.floor(budget.basis * .55)) : ''
  const basis = [
    panelText ? '【上一轮面板（本轮基准：没有变化的照抄，有变化的只改动了的那几行）】\n' + panelText : '',
    stateJson ? '【面板数值账本（本地结算后的当前值；面板里的数字必须与它一致，只提交本轮有依据的变动）】\n' + stateJson : ''
  ].filter(Boolean).join('\n\n')
  const first = !turns.some(m => m.role === 'assistant')
  const resident = first ? parts.resident : parts.resident.replace(/【开局场景：[^】]*】\n[\s\S]*?(?=\n【|$)/, '')
  const onStage = active.map(x => {
    const role = parts.roles.find(r => r.id === (typeof x === 'string' ? x : x.id))
    if (!role) return ''
    // Legacy roles carry a synthetic id; showing it to the model only adds noise.
    const label = String(role.id ?? '').startsWith('legacy-') ? '' : role.id + '｜'
    return role.name + '（' + label + (x.remote ? '远程提及，不在现场' : '现场') + '）'
  }).filter(Boolean).join('\n')
  const rosterHeader = '【本轮角色名单（引擎裁定）】\n' + (onStage || '暂无指定角色') + '\n远程提及不得视作在场；未列入者不得自行加入现场。\n【角色索引】\n'
  const index = buildRosterIndex(parts, active, Math.max(240, budget.roster - rosterHeader.length))
  const rosterBlock = rosterHeader + index.text
  const lastUser = [...turns].reverse().find(m => m.role === 'user')?.content ?? ''
  const recentText = recent.slice(-6).map(m => m.content).join('\n') + '\n' + lastUser + '\n' + onStage + (first ? '\n' + parts.scene : '')
  const wbHeader = '【本轮加载的设定（只加载到这些）】\n'
  const loaded = matchWorldBook(parts.worldBook, recentText, { maxChars: budget.worldBook - wbHeader.length,
    minChars: Math.floor(budget.worldBook * .15), fallbackText: recent.map(m => m.content).join('\n'),
    alwaysTags: first ? ['底下·档'] : [], priorityNames: parts.roles.filter(r => active.some(x => (typeof x === 'string' ? x : x.id) === r.id)).map(r => r.name),
    quotas: { 角色: Math.max(4, active.length * 2 + 2) } })
  const wbBlock = loaded.length ? wbHeader + loaded.map(e => '【' + (e.tag || '设定') + '】\n' + e.value).join('\n\n') : ''
  const initialLimit = Math.max(2, Math.min(Math.floor(budget.basis * .55), budget.basis - stateJson.length - 200))
  const initial = first ? '【开局初始数值】\n' + (Object.keys(parts.initialStats).length ? boundedJson(projectLedger(parts.initialStats, parts, active), initialLimit) : clipText(parts.initialText, initialLimit)) : ''
  // Each section includes its headings in the allocation; separators count in total too.
  const ledgerBlock = stateJson ? '【面板数值账本（本地结算后的当前值；面板里的数字必须与它一致，只提交本轮有依据的变动）】\n' + stateJson : ''
  const basePrefix = initial + (basis ? '\n\n【续局基准】\n' : '') + ledgerBlock
  const baseBlock = basePrefix + clipText(panelText ? '\n【上一轮面板（本轮基准：没有变化的照抄，有变化的只改动了的那几行）】\n' + panelText : '', budget.basis - basePrefix.length - 6)
  const sections = [residentWithinBudget(resident, budget.resident), rosterBlock, wbBlock, baseBlock]
  const system = sections.filter(Boolean).join('\n\n')
  const request = [
    { role: 'system', content: system },
    ...(recent.length ? recent : [{ role: 'user', content: '按开局场景开始第一轮。' }])
  ]
  Object.defineProperty(request, 'context', { value: { budget, sizes: { resident: sections[0].length, roster: rosterBlock.length, worldBook: wbBlock.length, basis: baseBlock.length }, total: system.length,
    clipped: [resident.length > budget.resident ? '常驻规则' : '', (basePrefix + panelText).length > budget.basis ? '续局面板' : '',
      index.missing > 0 ? '角色索引只列出 ' + index.listed + '/' + index.total + ' 人' : ''].filter(Boolean) } })
  return request
}

function transcriptPlayer(opening, fields) {  const profile = /^【玩家自定义档案】\n([\s\S]*?)\n【开局初始数值】$/m.exec(opening)?.[1] ?? ''
  const paired = fields.some(field => field.key === 'age') && fields.some(field => field.key === 'job')
  const labels = new Set([...fields.map(field => field.label), '特殊设定'])
  if (paired) labels.add('年龄与职业')
  const values = new Map()
  const headings = [...profile.matchAll(/^- ([^：\n]+)：/gm)]
  for (const [index, heading] of headings.entries()) {
    if (!labels.has(heading[1])) continue
    const value = profile.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()
    values.set(heading[1], value === '未填写' ? '' : value)
  }
  const player = Object.fromEntries(fields.map(({ key, label }) => [key, values.get(label) ?? '']))
  if (paired && values.has('年龄与职业')) {
    const value = values.get('年龄与职业')
    const separator = value.indexOf(' · ')
    if (separator >= 0) {
      player.age = value.slice(0, separator)
      player.job = value.slice(separator + 3)
    } else if (/^\d/.test(value)) {
      player.age = value
    } else {
      player.job = value
    }
  }
  return player
}

export function readStoryTranscript(raw, scripts, currentId) {
  const source = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const prefix = '【玩家】\n'
  const world = /^【玩家】\n【剧本与世界观】\n([^\n]+)/.exec(source)
  check(world, '请选择本网页「导出记录」生成的 TXT 文件。')

  const matches = [...scripts].filter(({ title }) => world[1] === title || world[1].startsWith(title + ' · '))
    .sort((a, b) => b.title.length - a.title.length)
  const candidates = matches.filter(script => script.title === matches[0].title)
  const script = candidates.find(script => script.id === currentId) ?? (candidates.length === 1 ? candidates[0] : null)
  check(script, candidates.length ? '剧本库有同名剧本，请先选中这份记录对应的剧本。' : '剧本库找不到这份记录的剧本，请先导入对应的剧本。')

  const boundaries = [...source.matchAll(/\n\n---\n\n【([^】\n]+)】\n/g)]
    .filter(match => ['玩家', script.title, '角色'].includes(match[1]))
  const messages = []
  let role = 'user'
  let offset = prefix.length
  for (const boundary of boundaries) {
    messages.push({ role, content: source.slice(offset, boundary.index) })
    role = boundary[1] === '玩家' ? 'user' : 'assistant'
    offset = boundary.index + boundary[0].length
  }
  messages.push({ role, content: source.slice(offset) })
  check(messages.every(message => text(message.content)), '记录中有空消息，无法导入。')

  const opening = messages[0].content
  const protocol = /^【PRISM 每轮状态协议】$/m.exec(opening)
  let ledger = null
  let memory = null
  let missingLedgerTurns = 0
  let panels = new Map()
  if (protocol) {
    const seedText = /^开局账本种子：[ \t]*(.+)$/m.exec(opening.slice(protocol.index))?.[1]
    if (seedText) {
      try {
        const seed = JSON.parse(seedText)
        validatePrismSeed(seed, Object.keys(seed.members ?? {}).filter(name => name !== '玩家').map(name => ({ name })))
        ledger = startLedger(seed, script.fans)
        readStorySave({ kind: 'story-card-save', version: 1, scriptId: script.id, scriptTitle: script.title,
          player: {}, messages: [messages[0]], panels: [], ledger, memory: { recent: [], archive: [], nextId: 1 } })
      } catch {
        ledger = null
      }
    }
    memory = { recent: [], archive: [], nextId: 1 }
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const reply = splitPrismTurn(message.content, panels)
      const result = settlePrismTurn(memory, ledger, reply)
      memory = result.memory
      panels = new Map(result.panels.filter(panel => panel.text).map(panel => [panel.title, panel.text]))
      if (!result.ledgerApplied) missingLedgerTurns++
      ledger = result.ledger
      if (result.warnings.length) message.warnings = result.warnings
    }
  }

  const save = {
    kind: 'story-card-save', version: 1, scriptId: script.id, scriptTitle: script.title,
    player: transcriptPlayer(opening, script.playerFields), messages, panels: [...panels], ledger, memory
  }
  return { save, missingLedgerTurns }
}

export function readStorySave(save) {
  check(save?.kind === 'story-card-save' && save.version === 1, '存档类型或版本不支持。')
  check(key(save.scriptId) && text(save.scriptTitle), '存档缺少剧本信息。')
  check(record(save.player) && Object.values(save.player).every(value => typeof value === 'string'), '玩家档案无效。')
  const saveOpening = typeof save.opening === 'string' && save.opening ? save.opening : (save.messages?.[0]?.content || '')
  // 开局设定不进 messages 之后，第一条可能是 assistant（AI 先写第一轮），不再强制是 user。
  check(Array.isArray(save.messages) &&
    save.messages.every(message => ['user', 'assistant'].includes(message?.role) && text(message.content) &&
      (message.warnings === undefined || (message.role === 'assistant' && Array.isArray(message.warnings) &&
        message.warnings.length <= 12 && message.warnings.every(warning => text(warning) && warning.length <= 250)))), '对话记录无效。')
  check(Array.isArray(save.panels) && save.panels.every(pair =>
    Array.isArray(pair) && pair.length === 2 && typeof pair[1] === 'string' &&
    (!saveOpening.includes('【PRISM 每轮状态协议】') || prismPanels.some(([title]) => title === pair[0]))), '状态面板无效。')
  check(save.panelsMode === undefined || save.panelsMode === null || ['prism', 'custom'].includes(save.panelsMode), '面板模式存档无效。')
  check(save.panelState === undefined || save.panelState === null || record(save.panelState), '面板数值存档无效。')
  check(save.roster === undefined || (Array.isArray(save.roster) && save.roster.every(r =>
    typeof r === 'string' ? key(r) : record(r) && key(r.id) && typeof r.remote === 'boolean') &&
    new Set(save.roster.map(r => typeof r === 'string' ? r : r.id)).size === save.roster.length), '在场名单存档无效。')
  check(save.rosterAt === undefined || (Number.isSafeInteger(save.rosterAt) && save.rosterAt >= 0 && save.rosterAt < save.messages.length), '在场名单消息下标无效。')
  check(save.rosterLocation === undefined || typeof save.rosterLocation === 'string', '在场地点存档无效。')

  const prism = saveOpening.includes('【PRISM 每轮状态协议】')
  const { memory, ledger } = save
  if (prism) {
    const validEntries = entries => Array.isArray(entries) && entries.every(entry =>
      Number.isSafeInteger(entry?.id) && entry.id > 0 && entry.id < memory.nextId && text(entry.text))
    check(Number.isSafeInteger(memory?.nextId) && memory.nextId >= 1 &&
      validEntries(memory.recent) && memory.recent.length <= 4 && validEntries(memory.archive), '记忆档案无效。')
    check(memory.archive.every(entry => entry.sources === undefined ||
      (validEntries(entry.sources) && entry.sources.length === 2 && entry.sources[0].id === entry.id &&
        entry.sources[1].id > entry.id && entry.sources.every(source => source.sources === undefined))), '记忆合并记录无效。')
  } else {
    check(memory === null && ledger === null, '非 PRISM 存档含有不匹配的账本或记忆。')
  }
  if (ledger !== null) {
    const validFields = (value, limits) => record(value) && Object.entries(value).every(([field, number]) =>
      Object.hasOwn(limits, field) && Number.isSafeInteger(number) && number >= 0 && number <= limits[field])
    check(Number.isSafeInteger(ledger?.day) && ledger.day >= 1 && record(ledger.members) &&
      record(ledger.pairs) && record(ledger.dayStart), '账本结构无效。')
    if (ledger.milestones !== undefined) {
      const possible = Object.keys(ledger.members).filter(name => name !== '玩家').flatMap(name =>
        [...relationshipEvents.keys()].filter(type => type !== 'cost').map(type => type + ':' + name))
      check(Array.isArray(ledger.milestones) && new Set(ledger.milestones).size === ledger.milestones.length &&
        ledger.milestones.every(id => possible.includes(id)), '关系事件存档无效。')
    }
    if (ledger.affectionChanges !== undefined) {
      check(Array.isArray(ledger.affectionChanges) && ledger.affectionChanges.length <= Object.keys(ledger.members).length &&
        ledger.affectionChanges.every(change => Object.hasOwn(ledger.members, change?.name) &&
          Number.isSafeInteger(change.delta) && change.delta !== 0 && Math.abs(change.delta) <= 10 &&
          text(change.reason) && change.reason.length <= 180), '好感变动记录无效。')
    }
    if (ledger.fandom !== undefined) {
      validateFanProfiles(ledger.fandom?.profiles)
      check(Array.isArray(ledger.fandom.posts) && ledger.fandom.posts.length <= fanLimit * 2 &&
        ledger.fandom.posts.every(post => text(post?.content) && post.content.length <= 180 &&
          ledger.fandom.profiles.some(fan => fan.id === post.id)), '粉丝发言存档无效。')
    }
    validatePrismSeed(ledger, Object.keys(ledger.members).filter(name => name !== '玩家').map(name => ({ name })))
    check(Object.values(ledger.members).every(entry => validFields(entry, { ...memberLimits, ...relationshipLimits })) &&
      Object.values(ledger.pairs).every(entry => validFields(entry, pairLimits)) &&
      Object.entries(ledger.dayStart).every(([name, value]) =>
        Object.hasOwn(ledger.members, name) && Number.isSafeInteger(value) && value >= 0 && value <= memberLimits.popularity), '账本数值无效。')
  }
  const rosterValid = save.rosterAt === undefined || save.rosterAt === save.messages.findLastIndex(m => m.role === 'assistant')
  return { ...save, prism, roster: rosterValid ? save.roster ?? [] : [], panels: new Map(save.panels) }
}

export async function completePrismReply(raw, requestMetadata, needsLedger) {
  const categories = /^【(?:排练|社交|个人|查看|剧情特殊|休息|工作)】/
  const complete = turn => new Set(turn.checks.map(line => line[0])).size === 8 &&
    turn.choices.slice(0, 5).filter(choice => categories.test(choice)).length === 5 &&
    (!needsLedger || Number.isSafeInteger(turn.stats?.day))

  let result = splitPrismTurn(raw)
  if (!complete(result)) {
    try {
      const repair = await requestMetadata(result.body)
      const marker = /^[ \t]*---THINK---[ \t]*\r?$/m.exec(repair)
      if (marker) {
        const candidate = result.body + '\n\n' + repair.slice(marker.index)
        const parsed = splitPrismTurn(candidate)
        if (complete(parsed)) {
          raw = candidate
          result = parsed
        }
      }
    } catch {
      // Keep the original narrative and any usable panels if metadata repair fails.
    }
  }
  if (result.choices.length > 5 || (result.choices.length && !/^---CHOICES---[ \t]*\r?$/m.test(raw))) {
    const { body } = splitChoices(raw)
    if (body !== raw) raw = body + '\n\n---CHOICES---\n' + result.choices.slice(0, 5).join('\n')
  }
  return raw
}




