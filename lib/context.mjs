import { resolveRoster, samePlace } from './roster.mjs'

export const clipText = (value, limit) => String(value ?? '').slice(0, Math.max(0, limit))
const marker = /\n【引擎上下文v2】\n([^\n]+)\n【引擎上下文结束】/

export function encodeOpening(raw, script, draft) {
  const route = (draft.routes ?? script.routes).find(x => x.id === draft.routeId) ?? script.routes[0]
  const initialStats = Object.fromEntries(script.roles.filter(r => r.tier !== 'extra').map(role => [role.id,
    Object.fromEntries(role.stats.map(s => [s.key, route.custom ? s.default : route.stats?.[role.id]?.[s.key] ?? s.default]))]))
  const roles = script.roles.map(r => ({ ...r, tier: r.tier ?? 'cast' }))
  const roleEntries = roles.map(r => ({ key: '_or_' + [r.name, ...(r.aliases ?? [])].join('@wb@'), tag: '角色',
    value: r.name + '：' + r.profile + (r.stats.length ? '\n首次登场参考初值（当前账本优先）：' + JSON.stringify(initialStats[r.id] ?? {}) : '') }))
  const index = roles.filter(r => r.tier !== 'extra').sort((a,b) => (a.tier === 'cast' ? 0 : 1) - (b.tier === 'cast' ? 0 : 1))
    .map(r => r.name + '（' + r.id + '｜' + r.tier + '｜' + (r.where ?? '地点未定') + '）：' + r.profile.slice(0, 40)).join('\n')
  const setting = { ...script.setting, ...draft.setting }
  const metadata = { roles: roles.map(({ profile, ...r }) => r), initialStats, policy: setting.castPolicy ?? {}, location: setting.place }
  let output = raw.replace(/【角色设定】\n[\s\S]*?(?=\n【玩家自定义档案】)/, '【角色索引】\n' + index + '\n')
  const block = roleEntries.map(e => '<<WB|' + e.key.replace(/[|>]/g, '') + '|角色>>\n' + e.value + '\n<</WB>>').join('\n')
  if (output.includes('【世界书结束】')) output = output.replace('【世界书结束】', block + '\n【世界书结束】')
  else output += '\n【世界书·按需加载】\n' + block + '\n【世界书结束】'
  return output + '\n【引擎上下文v2】\n' + JSON.stringify(metadata) + '\n【引擎上下文结束】'
}

/** Old saves are parsed in memory only; their source opening is never overwritten. */
export function parseOpening(opening, splitWorldBook) {
  const match = marker.exec(opening)
  let meta = null
  if (match) { try { meta = JSON.parse(match[1]) } catch { /* legacy fallback */ } }
  const wb = splitWorldBook(opening.replace(marker, ''))
  const roleBlock = /【角色设定】\n([\s\S]*?)(?=\n【玩家自定义档案】)/.exec(wb.base)
  const legacyRoles = roleBlock ? [...roleBlock[1].matchAll(/^([^：\n]+)：([^\n]*)/gm)].map((m, i) => ({ id: 'legacy-' + i, name: m[1], profile: m[2], tier: 'cast' })) : []
  const roles = meta?.roles ?? legacyRoles
  const entries = [...wb.entries, ...legacyRoles.map(r => ({ key: r.name, tag: '角色', value: r.name + '：' + r.profile }))]
  const initial = /【开局初始数值】\n([\s\S]*?)(?=\n【开局场景：)/.exec(wb.base)?.[1] ?? ''
  const scene = /【开局场景：[^】]*】\n([\s\S]*?)(?=\n【|$)/.exec(wb.base)?.[1] ?? ''
  const index = /【角色索引】\n([\s\S]*?)(?=\n【玩家自定义档案】)/.exec(wb.base)?.[1] ?? ''
  const resident = wb.base.replace(/【角色(?:设定|索引)】\n[\s\S]*?(?=\n【玩家自定义档案】)/, '')
    .replace(/【开局初始数值】\n[\s\S]*?(?=\n【开局场景：)/, '')
    .replace(/^开局账本种子：[^\n]*\n?/m, '')
  return { resident, roles, worldBook: entries, initialStats: meta?.initialStats ?? {}, initialText: initial, scene, rosterIndex: index, policy: meta?.policy ?? {}, location: meta?.location ?? /^地点：(.*)$/m.exec(resident)?.[1] ?? '', legacy: !meta }
}

export function contextBudget(parts) {
  const total = parts.policy.contextBudgetChars ?? 24000
  const resident = Math.floor(total * .4), roster = Math.floor(total * .1), worldBook = Math.floor(total * .3)
  return { total, resident, roster, worldBook, basis: total - resident - roster - worldBook }
}

export function residentWithinBudget(text, limit) {
  if (text.length <= limit) return text
  const rule = /规则：([\s\S]*?)(?=\n【玩家自定义档案】|$)/.exec(text)
  if (rule) {
    const paragraphs = rule[1].trim().split(/\n\s*\n/)
    const tail = paragraphs.slice(-2).join('\n\n')
    const room = Math.max(0, limit - (text.length - rule[1].length) - tail.length - 12)
    const head = []
    for (const paragraph of paragraphs.slice(0, -2)) {
      if ([...head, paragraph].join('\n\n').length > room) break
      head.push(paragraph)
    }
    text = text.replace(rule[0], '规则：' + head.join('\n\n') + '\n…\n' + tail)
  }
  if (text.length <= limit) return text
  // Keep both the initial identity and the final output protocol visible.
  const half = Math.floor((limit - 4) / 2)
  return text.slice(0, half) + '\n…\n' + text.slice(-(limit - half - 3))
}

/** Keep JSON syntactically complete even when one branch alone exceeds the request budget. */
export function boundedJson(value, limit) {
  const whole = JSON.stringify(value)
  if (whole.length <= limit) return whole
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const result = {}
  for (const [k,v] of Object.entries(value)) {
    const size = limit - JSON.stringify(result).length - JSON.stringify(k).length - 2
    if (size < 2) break
    const encoded = boundedJson(v, size)
    if (!encoded) continue
    const next = { ...result, [k]: JSON.parse(encoded) }
    if (JSON.stringify(next).length <= limit) Object.assign(result, next)
  }
  return limit >= 2 ? JSON.stringify(result) : ''
}

export function projectPanelText(text, parts, roster) {
  const active = new Set(roster.map(x => typeof x === 'string' ? x : x.id))
  const keep = value => {
    const named = parts.roles.filter(r => value.includes(r.name))
    return !named.length || named.some(r => active.has(r.id))
  }
  // Remove an absent character's whole paragraph, including unnamed continuation lines.
  // Mixed paragraphs still need the line filter for compact lists with several characters.
  return String(text).split(/\n\s*\n/).filter(keep).map(paragraph => paragraph.split('\n').filter(line => {
    const named = parts.roles.filter(r => line.includes(r.name))
    return !named.length || named.some(r => active.has(r.id))
  }).join('\n')).join('\n\n')
}

export function requestRoster(parts, previous, input, location = parts.location, previousLocation = location) {
  const policy = parts.policy
  const maxOnStage = policy.maxOnStage ?? 8
  const always = new Set(policy.alwaysOnStage ?? [])
  let roster = resolveRoster(parts.roles, { location, previousLocation, playerInput: input, lastRoster: previous,
    maxOnStage, alwaysOnStage: policy.alwaysOnStage ?? [] })
  // The opening never starts empty. A script whose `where` matches no location would otherwise stage
  // nobody on turn one. Priority: alwaysOnStage → named in the opening scene → at this location →
  // everyone else, so a location-only script still opens with its cast instead of a blank stage.
  if (!roster.length && !previous.length) {
    const pool = parts.roles.filter(r => r.tier !== 'extra')
    const isAlways = r => always.has(r.id) || (r.aliases ?? []).some(a => always.has(a))
    const named = r => parts.scene.includes(r.name)
    const here = r => !r.where || samePlace(r.where, location)
    const ordered = [...pool.filter(r => isAlways(r) || named(r) || here(r)), ...pool]
    const picked = new Map()
    for (const role of ordered) {
      if (picked.size >= maxOnStage) break
      if (!picked.has(role.id)) picked.set(role.id, { id: role.id, remote: false })
    }
    roster = [...picked.values()]
  }
  return roster
}

export function projectLedger(value, parts, roster) {
  const all = new Set(parts.roles.flatMap(r => [r.id, r.name]))
  const active = new Set(parts.roles.filter(r => roster.some(x => (typeof x === 'string' ? x : x.id) === r.id)).flatMap(r => [r.id, r.name]))
  const walk = obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !all.has(k) || active.has(k)).map(([k,v]) => [k,walk(v)]))
  }
  return walk(value)
}

/**
 * Layered roster index. Every role stays reachable, but the amount of text is bounded:
 *   1. roles on stage  → full line (id, place, a short profile)
 *   2. other cast      → short line (id and place)
 *   3. support         → one line per location, names shortened until it fits
 *   4. extras          → a count
 * Whatever still does not fit is reported as a number, never dropped in silence. The number of
 * roles the model can see is therefore set by the budget, not by a hard cap on the script.
 */
export function buildRosterIndex(parts, active = [], limit = 2400) {
  const activeIds = new Set(active.map(x => typeof x === 'string' ? x : x.id))
  const cast = parts.roles.filter(r => (r.tier ?? 'cast') === 'cast')
  const support = parts.roles.filter(r => r.tier === 'support')
  const extras = parts.roles.filter(r => r.tier === 'extra')
  const summaries = new Map()
  for (const line of String(parts.rosterIndex ?? '').split('\n')) {
    const cut = line.indexOf('）：')
    const paren = cut > 0 ? line.lastIndexOf('（', cut) : -1
    if (paren > 0) summaries.set(line.slice(0, paren).trim(), line.slice(cut + 2).trim().slice(0, 36))
  }
  const whereOf = r => (typeof r.where === 'string' && r.where.trim() ? r.where.trim() : '地点未定')
  // A role recovered from a legacy opening has a synthetic id and no place: keep its line to the name.
  const shortOf = r => (String(r.id ?? '').startsWith('legacy-') ? r.name : r.name + '（' + r.id + '｜' + whereOf(r) + '）')
  const fullOf = r => {
    const summary = summaries.get(r.name) ?? String(r.profile ?? '').trim().slice(0, 36)
    return summary ? shortOf(r) + '：' + summary : shortOf(r)
  }
  const lines = []
  let left = Math.max(0, limit - 90)
  const add = value => {
    if (!value) return false
    const cost = value.length + (lines.length ? 1 : 0)
    if (cost > left) return false
    lines.push(value); left -= cost; return true
  }
  const listed = new Set()
  // 1) On stage: full line, falling back to the short form before giving up.
  for (const role of [...cast, ...support].filter(r => activeIds.has(r.id))) {
    if (listed.has(role.id)) continue
    if (!add(fullOf(role)) && !add(shortOf(role))) break
    listed.add(role.id)
  }
  // 2) Every other cast member. A short line costs ~18 characters and a grouped name ~5, so the
  //    split that lists the most people is solved rather than guessed: when the cast no longer fits
  //    line by line, everything moves to the grouped lines below instead of dropping whoever is last.
  const rest = cast.filter(r => !listed.has(r.id))
  const leftover = []
  if (rest.length) {
    // A budget with room to spare should buy a summary, not just a name. A bare name tells the model
    // nobody exists, and a role the model never names is never mentioned, so its entry is never
    // loaded — the same deadlock the truncation caused, just softer. So: if every remaining cast
    // member fits with its summary, list them all that way; only squeeze into short lines when the
    // summaries would not fit.
    const fullTotal = rest.reduce((sum, r) => sum + fullOf(r).length + 1, 0)
    if (fullTotal <= left) {
      for (const role of rest) if (add(fullOf(role))) listed.add(role.id)
    } else {
      const avgShort = Math.round(rest.reduce((sum, r) => sum + shortOf(r).length, 0) / rest.length) + 1
      const avgName = Math.max(3, Math.round(rest.reduce((sum, r) => sum + r.name.length, 0) / rest.length)) + 1
      const roomy = avgShort > avgName ? Math.floor((left - avgName * rest.length) / (avgShort - avgName)) : rest.length
      const shortLines = Math.max(0, Math.min(rest.length, roomy))
      rest.forEach((role, i) => {
        if (i < shortLines && add(shortOf(role))) listed.add(role.id)
        else leftover.push(role)
      })
    }
  }
  // 2b) Support gets the same treatment before being compressed into location groups: a group line
  //     leaves a bare name, which makes the role reachable but gives the model no reason to reach.
  const supRest = support.filter(r => !listed.has(r.id))
  if (supRest.length) {
    const fullTotal = supRest.reduce((sum, r) => sum + fullOf(r).length + 1, 0)
    if (fullTotal <= left) for (const role of supRest) if (add(fullOf(role))) listed.add(role.id)
  }
  // 3) Support and any overflow cast: one line per location. The name space left over is split by
  //    group size, so every location keeps a share instead of the first one eating the whole budget.
  const groups = new Map()
  for (const role of [...support.filter(r => !listed.has(r.id)), ...leftover]) {
    const place = whereOf(role)
    if (!groups.has(place)) groups.set(place, [])
    groups.get(place).push(role)
  }
  const groupList = [...groups].filter(([, group]) => group.length)
  if (groupList.length) {
    const headTotal = groupList.reduce((sum, [place, group]) => sum + place.length + String(group.length).length + 5, 0)
    const nameRoom = Math.max(0, left - headTotal - 20)
    const totalGrouped = groupList.reduce((sum, [, group]) => sum + group.length, 0)
    for (const [place, group] of groupList) {
      const nameLen = Math.max(3, Math.round(group.reduce((sum, r) => sum + r.name.length, 0) / group.length)) + 1
      const share = totalGrouped ? Math.floor(nameRoom * (group.length / totalGrouped)) : 0
      const fit = Math.max(0, Math.min(group.length, Math.floor(share / nameLen)))
      const shown = group.slice(0, fit)
      const head = place + '（' + group.length + '）：'
      const line = fit < group.length ? head + shown.map(r => r.name).join('、') + '…（共 ' + group.length + ' 人）'
        : head + shown.map(r => r.name).join('、')
      if (add(line)) shown.forEach(r => listed.add(r.id))
      else if (add(head + '名字未展开')) { /* the place still has to be visible */ }
    }
  }
  // 4) Anything left is stated as a count.
  const total = cast.length + support.length
  const missing = total - listed.size
  const tail = []
  if (missing > 0) tail.push('另有 ' + missing + ' 名角色未列入本索引（可按地点或姓名问询其身份）')
  if (extras.length) tail.push('背景人物 ' + extras.length + ' 名（只作气氛，不单独列出）')
  const tailText = tail.join('；')
  if (tailText && !add(tailText) && left > 8) lines.push(clipText(tailText, left))
  return { text: lines.join('\n'), listed: listed.size, total, extras: extras.length, missing: Math.max(0, missing) }
}
