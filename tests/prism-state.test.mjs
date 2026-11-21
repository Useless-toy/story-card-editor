import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { completePrismReply, normalizeFanPlatforms, compile, createDraft, prismRequest, settlePrismTurn, startLedger, updateLedger, validateScript, readStorySave } from '../compiler.mjs'
import { alignAffectionText, prismChecks, splitPrismTurn, updatePrismMemory, withLedgerAffection } from '../lib/choices.mjs'

const script = validateScript(JSON.parse(readFileSync(new URL('./fixtures/ledger-cast.json', import.meta.url))))

test('ledger keeps separate counters and applies the cumulative daily popularity limit', () => {
  const start = startLedger(script.prismStats)
  const one = updateLedger(start, { day: 1, members: { 玩家: { popularity: 930, soloFans: 1230 } }, pairs: { 柔晚: { heat: 8300 } } })
  const two = updateLedger(one, { day: 1, members: { 玩家: { popularity: 980, cpFans: 20, passers: 101 } } })
  assert.deepEqual(two.members.玩家, { popularity: 950, soloFans: 1230, passers: 12, cpFans: 20, affection: 20 })
  assert.deepEqual(two.pairs.柔晚, { heat: 8300, fans: 45000 })
  assert.equal(two.members.姜柔.popularity, 8500)
  const tomorrow = updateLedger(two, { day: 2, members: { 玩家: { popularity: 1040 } } })
  assert.equal(tomorrow.members.玩家.popularity, 1040)
  // 模型写回退日期不再整包作废：日子不动，但 members 里的人气照常落地（旧行为是连 patch 一起丢）。
  const rewound = updateLedger(tomorrow, { day: 1, members: { 玩家: { popularity: 850 } } })
  assert.equal(rewound.day, tomorrow.day)
  assert.equal(rewound.members.玩家.popularity, 850)
  assert.equal(rewound.dayStart.玩家, tomorrow.dayStart.玩家)
  assert.equal(start.members.玩家.popularity, 850)
})

test('long request keeps canon, current ledger, and recent story while dropping old snapshots', () => {
  const opening = compile(script, createDraft(script))
  const messages = [{ role: 'user', content: opening }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: '行动 ' + i },
      { role: 'assistant', content: '剧情 ' + i + '\n---PRISM---\n【当前情况】\n过期状态 ' + i + '\n【工作记忆】\n过期记忆 ' + i })
  }
  messages.push({ role: 'user', content: '继续排练' })
  const ledger = updateLedger(startLedger(script.prismStats), { day: 1, members: { 玩家: { popularity: 910 } } })
  const request = prismRequest(messages, new Map([['工作记忆', '签售已改期']]), ledger)
  assert.equal(request.length, 13)
  assert.equal(request[0].role, 'system')
  assert.ok(request[0].content.startsWith('【剧本与世界观】'))
  assert.ok(request[0].content.includes(script.title))
  assert.ok(!request[0].content.includes('【引擎上下文v2】'))
  assert.ok(request[0].content.length <= 24000)
  assert.ok(request[0].content.includes('"popularity":910'))
  assert.ok(request[0].content.includes('签售已改期'))
  assert.match(request.at(-2).content, /当前情况】\n过期状态 29/)
  assert.match(request.at(-4).content, /当前情况】\n过期状态 28/)
  assert.ok(request.every(message => !message.content.includes('过期记忆')))
  assert.equal(request.at(-6).content, '剧情 27')
  assert.match(request[0].content, /【每轮输出骨架】[\s\S]*---CHOICES---/)
  assert.equal(request.at(-1).content, '继续排练')
  assert.equal(request.filter(message => message.content.includes('过期状态')).length, 2)
})

test('ledger proposals are hidden from prose and malformed data does not replace numbers', () => {
  const valid = splitPrismTurn('她关了灯。\n---PRISM---\n【PRISM-STATS】\n{"day":1}\n---CHOICES---\n① 回宿舍')
  assert.equal(valid.body, '她关了灯。')
  assert.deepEqual(valid.stats, { day: 1 })
  assert.deepEqual(valid.choices, ['回宿舍'])
  const bad = splitPrismTurn('她关了灯。\n---PRISM---\n【PRISM-STATS】\n{"day":')
  const ledger = startLedger(script.prismStats)
  assert.equal(updateLedger(ledger, bad.stats), ledger)
})


test('compiled PRISM and ordinary prompts both retain their narrative scale', () => {
  const sample = structuredClone(script)
  sample.style = { scale: '测试尺度配置' }
  for (const mode of ['prism', undefined]) {
    sample.turnPanels = mode
    const prompt = compile(sample, createDraft(sample))
    assert.match(prompt, /【叙述尺度 · 硬性要求】\n测试尺度配置/)
    assert.equal(prompt.includes('【PRISM 每轮状态协议】'), mode === 'prism')
    if (mode === 'prism') {
      assert.match(prompt, /第一轮也必须[^\n]*---PRISM---/)
      assert.match(prompt, /第一轮必须含【PRISM-STATS】/)
      assert.match(prompt, /【用户ID】：内容/)
      assert.match(prompt, /【排练】【社交】【个人】【查看】/)
    }
  }
})

test('turn audit stays separate from narrative, stats, and categorized choices', () => {
  const audit = prismChecks.map(([title], index) => (index + 1) + '. ' + title + '：本轮已核对。')
  const text = ['她走进练习室。', '---THINK---', ...audit, '---PRISM---', '【当前情况】',
    '只有两人在场。', '【PRISM-STATS】', '{"day":1}', '---CHOICES---',
    '① 【排练】再练一次', '② 【查看】看看超话'].join('\n')
  const parsed = splitPrismTurn(text)
  assert.equal(parsed.body, '她走进练习室。')
  assert.deepEqual(parsed.checks, audit)
  assert.equal(parsed.panels[0].text, '只有两人在场。')
  assert.deepEqual(parsed.stats, { day: 1 })
  assert.deepEqual(parsed.choices, ['【排练】再练一次', '【查看】看看超话'])
})

test('six turns retain four working memories and group the oldest facts without losing their IDs', () => {
  let memory = { recent: [], archive: [], nextId: 1 }
  for (let i = 1; i <= 6; i++) {
    const sections = [
      { title: '工作记忆', text: '[1]（第' + i + '天）完成通告 ' + i },
      { title: '历史档案', text: i === 2 ? '[99]（第2天）完成通告 2' : '无新增' }
    ]
    memory = updatePrismMemory(memory, sections).memory
    assert.ok(memory.recent.length <= 4)
  }
  assert.deepEqual(memory.recent.map(entry => entry.id), [3, 4, 5, 6])
  assert.deepEqual(memory.archive.map(entry => entry.id), [1])
  assert.deepEqual(memory.archive[0].sources.map(entry => entry.id), [1, 2])
  const repeat = updatePrismMemory(memory, [{ title: '工作记忆', text: '[100] （第6天）完成通告 6' }])
  assert.deepEqual(repeat.memory, memory)
  assert.equal(repeat.panels[0].text.split('\n')[0], '当前记忆数目：4/4')
})

test('turn 15 retrieves a private turn 3 promise only for the teammate who knows it', () => {
  const draft = createDraft(script)
  const ledger = startLedger(script.prismStats)
  const messages = [{ role: 'user', content: compile(script, draft) }]
  let memory = { recent: [], archive: [], nextId: 1 }
  let panels
  for (let turn = 1; turn < 15; turn++) {
    const fact = turn === 3 ? '【知情：陆星晚】【待办】陆星晚答应周五去北门取蓝封信，先敲三下。' : '【公开】第' + turn + '轮完成通告。'
    const reply = '剧情 ' + turn + '\n---PRISM---\n【工作日程 & 本周事件】\n公开彩排；待确认北门蓝封信。\n【工作记忆】\n[1] ' + fact + '\n【历史档案】\n无新增'
    messages.push({ role: 'user', content: '继续处理通告' }, { role: 'assistant', content: reply })
    const result = updatePrismMemory(memory, splitPrismTurn(reply).panels)
    memory = result.memory
    panels = new Map(result.panels.map(panel => [panel.title, panel.text]))
    assert.ok(memory.recent.length <= 4)
    if (turn === 10) assert.ok(memory.archive.length <= 8)
  }
  const loaded = readStorySave(JSON.parse(JSON.stringify({ kind: 'story-card-save', version: 1,
    scriptId: script.id, scriptTitle: script.title, player: draft.player, messages, panels: [...panels], ledger, memory })))
  const request = content => prismRequest([...loaded.messages, { role: 'user', content }], loaded.panels, ledger, loaded.memory)
  const recalled = request('去找陆星晚。')
  assert.match(recalled[0].content, /北门取蓝封信，先敲三下/)
  assert.doesNotMatch(recalled[0].content, /待确认北门蓝封信/)
  assert.match(recalled[0].content, /公开彩排/)
  assert.doesNotMatch(recalled[0].content, /第1轮完成通告/)
  assert.ok(recalled.slice(1).every(message => !message.content.includes('工作记忆】')))
  for (const action of ['去找姜柔。', '和姜柔一起去找陆星晚。']) {
    assert.ok(request(action).every(message => !message.content.includes('蓝封信')))
  }
})

test('a long archive shows a bounded overview and retains the original facts for targeted recall', () => {
  const opening = compile(script, createDraft(script))
  const ledger = startLedger(script.prismStats)
  const archive = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    text: index === 0 ? '【公开】青鸟电台取消直播，改为白鹭剧场录音。' : '【公开】第' + (index + 1) + '次彩排结束。'
  }))
  const { memory, panels } = updatePrismMemory({ recent: [], archive, nextId: 22 }, [{ title: '历史档案', text: '无新增' }])
  assert.deepEqual(memory.archive, archive)
  assert.match(panels[0].text, /^当前档案数目：17（原档案 21 份）\n1\. \[1\] 早期概况.*青鸟电台取消直播/m)
  const [request] = prismRequest([{ role: 'user', content: opening }, { role: 'user', content: '去查青鸟电台的安排。' }],
    new Map(panels.map(panel => [panel.title, panel.text])), ledger, memory)
  assert.match(request.content, /青鸟电台取消直播，改为白鹭剧场录音/)
  assert.doesNotMatch(request.content, /第21次彩排结束/)
})


test('existing saves can acquire allowlisted relationship fields only', () => {
  const current = startLedger(script.prismStats)
  delete current.members.陆星晚.affection
  const next = updateLedger(current, { day: 1, members: { 陆星晚: { affection: 22, affectionReason: '帮忙校对走位', trust: 35, suspicion: 101, arbitrary: 3 } } })
  assert.equal(next.members.陆星晚.affection, 22)
  assert.equal(next.members.陆星晚.trust, 35)
  assert.equal(next.members.陆星晚.suspicion, undefined)
  assert.equal(next.members.陆星晚.arbitrary, undefined)
  // 日期跳得太远只钳到 +1，成员补丁不再陪葬。
  const clamped = updateLedger(next, { day: 3 })
  assert.equal(clamped.day, 2)
  assert.deepEqual(clamped.members, next.members)
})

test('save round-trip keeps panels, memories and daily popularity baseline for the next turn', () => {
  const draft = createDraft(script, { player: { name: '林晚棠' } })
  const opening = compile(script, draft)
  const ledger = updateLedger(startLedger(script.prismStats), { day: 1, members: { 玩家: { popularity: 940 }, 陆星晚: { affection: 22, affectionReason: '帮忙校对走位' } } })
  const save = {
    kind: 'story-card-save', version: 1, scriptId: script.id, scriptTitle: script.title, player: draft.player,
    messages: [{ role: 'user', content: opening }, { role: 'assistant', content: '她去了练习室。' }],
    panels: [['当前情况', '上午排练'], ['工作记忆', '[1] 排练']],
    ledger, memory: { recent: [{ id: 1, text: '排练' }], archive: [], nextId: 2 }
  }
  const loaded = readStorySave(JSON.parse(JSON.stringify(save)))
  assert.deepEqual(loaded.messages, save.messages)
  assert.deepEqual([...loaded.panels], save.panels)
  assert.deepEqual(loaded.memory, save.memory)
  assert.deepEqual(loaded.ledger, save.ledger)
  const next = updateLedger(loaded.ledger, { day: 1, members: { 玩家: { popularity: 1040 } } })
  assert.equal(next.members.玩家.popularity, 950)
  const request = prismRequest([...loaded.messages, { role: 'user', content: '继续排练' }], loaded.panels, next)
  assert.ok(request[0].content.includes('上午排练'))
  assert.equal(request.at(-1).content, '继续排练')
  assert.throws(() => readStorySave({ ...save, ledger: { ...ledger, dayStart: { 玩家: -1 } } }), /账本数值无效/)
  assert.throws(() => readStorySave({ ...save, version: 2 }), /版本不支持/)
})


test('PRISM repairs missing metadata once and retains the original narrative', async () => {
  const audit = prismChecks.map(([title], index) => (index + 1) + '. ' + title + '：已核对。')
  const fixture = ['---THINK---', ...audit, '---PRISM---', '【当前情况】', '在练习室',
    '【PRISM-STATS】', '{"day":1}', '---CHOICES', ...['排练','社交','查看','工作','休息','个人'].map(category => '【' + category + '】继续')].join('\n')
  let repairs = 0
  const raw = await completePrismReply('原始正文。', async narrative => {
    assert.equal(narrative, '原始正文。')
    repairs++
    return fixture
  }, true)
  const parsed = splitPrismTurn(raw)
  assert.equal(repairs, 1)
  assert.equal(parsed.body, '原始正文。')
  assert.equal(parsed.checks.length, 8)
  assert.equal(parsed.choices.length, 5)
  assert.match(raw, /\n---CHOICES---\n/)
  assert.equal(await completePrismReply('原始正文。', async () => '修复仍缺少区块', true), '原始正文。')
})


test('affection changes require a reason and stay within ten points of the current value', () => {
  const start = startLedger(script.prismStats, script.fans)
  const unearned = updateLedger(start, { day: 1, members: { 陆星晚: { affection: 80 } } })
  assert.equal(unearned.members.陆星晚.affection, 20)
  assert.deepEqual(unearned.affectionChanges, [])
  const earned = updateLedger(unearned, { day: 1, members: { 陆星晚: { affection: 80, affectionReason: '帮她挡下了坠落的舞台道具' } } })
  assert.equal(earned.members.陆星晚.affection, 30)
  assert.deepEqual(earned.affectionChanges, [{ name: '陆星晚', delta: 10, reason: '帮她挡下了坠落的舞台道具' }])
  const loss = updateLedger(earned, { day: 1, members: { 陆星晚: { affection: 0, affectionReason: '公开转发了未经同意的排练录音' } } })
  assert.equal(loss.members.陆星晚.affection, 20)
})

test('fandom remembers recurring accounts and verifies new ones against published posts', () => {
  const start = startLedger(script.prismStats, script.fans)
  const newcomer = { id: '坐在返送旁', platform: 'B站', camp: '路人', stance: '比较各机位', tone: '引用时间戳' }
  const overwrite = { ...start.fandom.profiles[0], stance: '突然换阵营' }
  assert.equal(normalizeFanPlatforms('【抖音】【星晚的尾巴】：请看切片。', start.fandom), '【微博】【星晚的尾巴】：请看切片。')
  const first = updateLedger(start, { day: 1, newFans: [newcomer, overwrite] },
    '【微博】【星晚的尾巴】：第一支切片只拍了两拍。\n【B站】【坐在返送旁】：1:14 有广角。')
  assert.equal(first.fandom.profiles.length, script.fans.length + 1)
  assert.equal(first.fandom.profiles[0].stance, start.fandom.profiles[0].stance)
  const second = updateLedger(first, { day: 1 }, '【微博】【星晚的尾巴】：新机位也拍到了其他人。\n【抖音】【坐在返送旁】：不在该账号平台。')
  assert.equal(second.fandom.posts.length, 3)
  const opening = compile(script, createDraft(script))
  assert.match(opening, /【粉丝角色库】/)
  const [system] = prismRequest([{ role: 'user', content: opening }], new Map(), second)
  assert.match(system.content, /【当前粉丝档案】[\s\S]*新机位也拍到了其他人/)
  const save = { kind: 'story-card-save', version: 1, scriptId: script.id, scriptTitle: script.title, player: {},
    messages: [{ role: 'user', content: opening }], panels: [], ledger: second, memory: { recent: [], archive: [], nextId: 1 } }
  assert.deepEqual(readStorySave(JSON.parse(JSON.stringify(save))).ledger.fandom, second.fandom)
})



test('a far-future day is clamped to tomorrow and never discards the member patch', () => {
  const start = startLedger(script.prismStats)
  const seeded = updateLedger(start, { day: 1, members: { 玩家: { popularity: 900 } } })
  // 实测故障：账本 day=3、叙事已到 11/16、模型每轮写 +2，于是 members 全部被丢弃、账本永远不动。
  const jumped = updateLedger(seeded, { day: seeded.day + 3, members: {
    玩家: { popularity: 940, cpFans: 7 }, 陆星晚: { affection: 28, affectionReason: '一起核对了副歌走位' } },
  pairs: { 柔晚: { heat: 8300 } } })
  assert.equal(jumped.day, seeded.day + 1)
  assert.equal(jumped.members.玩家.popularity, 940)
  assert.equal(jumped.members.玩家.cpFans, 7)
  assert.equal(jumped.members.陆星晚.affection, 28)
  assert.equal(jumped.pairs.柔晚.heat, 8300)
  // 每天 ±100 人气的上限照旧生效。
  const capped = updateLedger(jumped, { day: jumped.day, members: { 玩家: { popularity: 5000 } } })
  assert.equal(capped.members.玩家.popularity, 1000)
})

test('a relationship turn with an out-of-range day still settles its members through settlePrismTurn', () => {
  const ledger = startLedger(script.prismStats)
  const memory = { recent: [], archive: [], nextId: 1 }
  const body = '你和陆星晚第一次接吻。'
  const event = { name: '陆星晚', type: 'first-kiss', fact: '两人私下确认彼此心意。', evidence: body }
  const turn = splitPrismTurn(body + ' \n---PRISM---\n【PRISM-STATS】\n' + JSON.stringify({
    day: 9, members: { 玩家: { popularity: 880, cpFans: 3 } }, relationshipEvents: [event] }))
  const next = settlePrismTurn(memory, ledger, turn)
  assert.equal(next.ledger.day, ledger.day + 1)
  assert.equal(next.ledger.members.玩家.popularity, 880)
  assert.equal(next.ledger.members.玩家.cpFans, 3)
  assert.equal(next.ledger.members.陆星晚.affection, 25)
  assert.equal(next.ledgerApplied, true)
})

test('the relationship panel shows the ledger affection instead of the number the model carried over', () => {
  const ledger = updateLedger(startLedger(script.prismStats), { day: 1,
    members: { 许恩霏: { affection: 30, affectionReason: '帮她改了口播' } } })
  const aligned = updateLedger(ledger, { day: 1, members: { 苏念清: { affection: 22, affectionReason: '替她顶了通告' } } })
  const panel = ['许恩霏 · 好感 48（+1）', '陆星晚 · 好感 47→48 · 信任 30', '苏念清 · 好感 22', '玩家 · 好感 60'].join('\n')
  assert.equal(aligned.members.苏念清.affection, 22)
  const fixed = alignAffectionText(panel, aligned.members)
  assert.equal(ledger.members.许恩霏.affection, 30)
  assert.match(fixed, /^许恩霏 · 好感 30（账本）（\+1）$/m)
  assert.match(fixed, /^陆星晚 · 好感 20（账本） · 信任 30$/m)
  // 面板数字与账本一致时原样保留，不重复标注。
  assert.match(fixed, /^苏念清 · 好感 22$/m)
  // 玩家不参与好感结算，也不被改写。
  assert.match(fixed, /^玩家 · 好感 60$/m)
  assert.equal(withLedgerAffection('队友关系', panel, aligned), fixed)
  assert.equal(withLedgerAffection('当前情况', panel, aligned), panel)
})
