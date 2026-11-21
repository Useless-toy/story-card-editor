import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compile, createDraft, customRequest, panelConfigOf, panelTitlesFromOpening, readStorySave, validateScript } from '../compiler.mjs'
import { mergePanelStats, panelStatDrops, splitPrismTurn } from '../lib/choices.mjs'

const load = async name => validateScript(JSON.parse(await readFile(new URL('./fixtures/' + name + '.json', import.meta.url))))
const loadFixture = async () => validateScript(JSON.parse(await readFile(new URL('./fixtures/minimal.json', import.meta.url))))
const prismPanels = ['【当前情况】', '【PRISM·成员状态】', '【队友关系】', '【团内CP热度榜】', '【工作日程 & 本周事件】', '【工作记忆】', '【历史档案】']

test('a custom script compiles its own panel protocol and none of the PRISM panels', async () => {
  for (const [name, titles] of [
    ['custom-panels', ['交互面板', '在场名单']],
  ]) {
    const script = await load(name)
    const prompt = compile(script, createDraft(script))
    assert.deepEqual(panelTitlesFromOpening(prompt), titles)
    assert.deepEqual(panelConfigOf(script).titles, titles)
    assert.ok(prompt.includes('---PANEL---'), name + ' 缺少面板分隔符')
    assert.ok(prompt.includes('---PANEL-STATS---'), name + ' 缺少面板账本分隔符')
    assert.ok(prompt.includes('---CHOICES---'), name + ' 缺少选项分隔符')
    assert.ok(!prompt.includes('【PRISM 每轮状态协议】'), name + ' 仍在注入 PRISM 协议')
    for (const panel of prismPanels) assert.ok(!prompt.includes(panel), name + ' 混进了 PRISM 面板 ' + panel)
    assert.ok(!prompt.includes('【状态栏协议】'), name + ' 退回了两行状态栏')
  }
})

test('PRISM and the two ordinary scripts keep their compiled prompt byte for byte', async () => {
  const prism = await load('ledger-cast')
  const prismText = compile(prism, createDraft(prism), { random: () => 0.5 })
  assert.ok(prismText.includes('【PRISM 每轮状态协议】'))
  assert.equal(panelTitlesFromOpening(prismText), null)
  for (const panel of prismPanels) assert.ok(prismText.includes(panel))
  const minimal = await loadFixture()
  const text = compile(minimal, createDraft(minimal))
  assert.ok(text.includes('【状态栏协议】'))
  assert.equal(panelTitlesFromOpening(text), null)
  assert.ok(!text.includes('---PANEL---'))
})

test('a custom turn splits by 【any title】 and reads its own stats line', async () => {
  const script = await load('custom-panels')
  const config = panelConfigOf(script)
  const raw = [
    '她把牛奶放在桌角，没有立刻走开。',
    '---PANEL---',
    '【交互面板】',
    '角色：周梦黎',
    '好感度：24（+4：你没拒绝那杯牛奶）',
    '性器：已被手指',
    '【在场名单】',
    '周梦黎 · 你书桌右侧 · 手臂还搭在桌沿',
    '林淮 · 靠窗下铺 · 抱着枕头看你',
    '---PANEL-STATS---',
    '{"day":2,"角色":{"周梦黎":{"好感":24,"占有欲":48}}}',
    '---CHOICES---',
    '① 把牛奶喝完',
    '② 问她今晚几点熄灯',
    '③ 去阳台吹会儿风'
  ].join('\n')
  const turn = splitPrismTurn(raw, new Map(), config)
  assert.equal(turn.body, '她把牛奶放在桌角，没有立刻走开。')
  assert.deepEqual(turn.panels.map(panel => panel.title), ['交互面板', '在场名单'])
  assert.match(turn.panels[0].text, /好感度：24/)
  assert.deepEqual(turn.stats, { day: 2, 角色: { 周梦黎: { 好感: 24, 占有欲: 48 } } })
  assert.equal(turn.choices.length, 3)
  // 上一轮的值在本轮缺失时沿用，并标记 carried
  const carried = splitPrismTurn('她转身去关灯。\n---PANEL---\n【在场名单】\n周梦黎 · 门口 · 手在灯绳上', new Map([['交互面板', '角色：周梦黎']]), config)
  assert.equal(carried.panels[0].text, '角色：周梦黎')
  assert.equal(carried.panels[0].carried, true)
})

test('PRISM splitting is untouched by a neighbouring custom config', () => {
  const raw = '排练结束。\n---PRISM---\n【队友关系】\n许恩霏：23（+3）\n【PRISM-STATS】\n{"day":1}\n---CHOICES---\n① 回宿舍'
  const plain = splitPrismTurn(raw)
  assert.equal(plain.panels.length, 7)
  assert.equal(plain.panels.find(panel => panel.title === '队友关系').text, '许恩霏：23（+3）')
  assert.deepEqual(plain.stats, { day: 1 })
  // 自定义 config 只认自己的标题：PRISM 的标题在它眼里不是段落
  const asCustom = splitPrismTurn(raw, new Map(), { titles: ['交互面板'], marker: 'PANEL', statsTitle: 'PANEL-STATS' })
  assert.deepEqual(asCustom.panels.map(panel => panel.title), ['交互面板'])
  assert.equal(asCustom.stats, null)
})

test('panel stats merge field by field and report drops without blocking them', () => {
  const first = mergePanelStats(null, { day: 1, 角色: { 周梦黎: { 好感: 20 } } })
  assert.deepEqual(first, { day: 1, 角色: { 周梦黎: { 好感: 20 } } })
  const next = mergePanelStats(first, { day: 2, 角色: { 林淮: { 好感: 30 } } })
  assert.deepEqual(next, { day: 2, 角色: { 周梦黎: { 好感: 20 }, 林淮: { 好感: 30 } } })
  assert.equal(first.角色.周梦黎.好感, 20, 'mergePanelStats 不许改原对象')
  assert.deepEqual(panelStatDrops(next, mergePanelStats(next, { 角色: { 周梦黎: { 好感: 18 } } })),
    ['角色·周梦黎 的「好感」20→18'])
  assert.deepEqual(panelStatDrops(first, mergePanelStats(first, { 角色: { 周梦黎: { 好感: 25 } } })), [])
})

test('customRequest carries the panel text and ledger into the system prompt', async () => {
  const script = await load('custom-panels')
  const config = panelConfigOf(script)
  const opening = compile(script, createDraft(script))
  const messages = [
    { role: 'user', content: opening },
    { role: 'assistant', content: '她推门进来。\n---PANEL---\n【交互面板】\n角色：周梦黎\n---PANEL-STATS---\n{"day":1,"角色":{"周梦黎":{"好感":20}}}\n---CHOICES---\n① 让开' },
    { role: 'user', content: '我让开半步' }
  ]
  const request = customRequest(messages, new Map([['交互面板', '角色：周梦黎\n好感度：20（初次见面）']]), { day: 1, 角色: { 周梦黎: { 好感: 20 } } }, config)
  assert.equal(request[0].role, 'system')
  assert.ok(request[0].content.includes('【每轮输出协议】'))
  assert.ok(request[0].content.includes('【续局基准】'))
  assert.ok(request[0].content.includes('好感度：20（初次见面）'))
  assert.ok(request[0].content.includes('"好感":20'))
  const history = request.filter(message => message.role === 'assistant')
  assert.equal(history[0].content, '她推门进来。', '历史的助手消息只留正文')
  assert.equal(request.at(-1).content, '我让开半步')
})

test('a custom save round-trips panels and panelState while PRISM saves stay strict', async () => {
  const base = {
    kind: 'story-card-save', version: 1, scriptId: 'dorm', scriptTitle: '什么叫舍友全是女同！？',
    player: {}, messages: [
      { role: 'user', content: '【剧本与世界观】\n什么叫舍友全是女同！？ · x\n【面板清单】交互面板｜在场名单（说明）\n---PANEL---' },
      { role: 'assistant', content: '正文\n---PANEL---\n【交互面板】\n角色：周梦黎' }
    ],
    panels: [['交互面板', '角色：周梦黎'], ['在场名单', '周梦黎 · 门口']],
    panelsMode: 'custom', panelState: { day: 1, 角色: { 周梦黎: { 好感: 20 } } },
    ledger: null, memory: null
  }
  const save = readStorySave(base)
  assert.equal(save.panelsMode, 'custom')
  assert.deepEqual(save.panelState, { day: 1, 角色: { 周梦黎: { 好感: 20 } } })
  assert.deepEqual([...save.panels.keys()], ['交互面板', '在场名单'])
  assert.throws(() => readStorySave({ ...base, panelsMode: 'weird' }), /面板模式存档无效/)
  assert.throws(() => readStorySave({ ...base, panelState: 'x' }), /面板数值存档无效/)
  // PRISM 存档仍然只认七段
  const prism = {
    ...base, scriptId: 'prism-draft', scriptTitle: 'PRISM',
    messages: [{ role: 'user', content: '【剧本与世界观】\nPRISM\n【PRISM 每轮状态协议】' }],
    panels: [['交互面板', '角色：周梦黎']], panelsMode: 'prism', panelState: null,
    memory: { recent: [], archive: [], nextId: 1 }, ledger: null
  }
  assert.throws(() => readStorySave(prism), /状态面板无效/)
})

test('turnPanels validation rejects shapes the compiler cannot honour', async () => {
  const script = await loadFixture()
  const withPanels = panels => validateScript({ ...structuredClone(script), turnPanels: panels })
  assert.throws(() => withPanels({ mode: 'custom' }), /协议不能为空/)
  assert.throws(() => withPanels({ mode: 'custom', protocol: 'x', panels: [] }), /1–12/)
  assert.throws(() => withPanels({ mode: 'custom', protocol: 'x', panels: ['交互面板', '交互面板'] }), /1–12/)
  assert.throws(() => withPanels({ mode: 'custom', protocol: 'x', panels: ['【交互面板】'] }), /1–12/)
  assert.throws(() => withPanels({ mode: 'other' }), /turnPanels/)
  assert.ok(withPanels({ mode: 'custom', protocol: '正文后写 ---PANEL---', panels: ['交互面板'] }))
  assert.ok(withPanels('prism'))
})

