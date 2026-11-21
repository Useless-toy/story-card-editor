import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, compileParts, createDraft, customRequest, matchWorldBook, parseOpening, prepareRequestRoster, readStorySave, validateScript } from '../compiler.mjs'
import { resolveRoster, rosterWarnings } from '../lib/roster.mjs'
import { boundedJson, residentWithinBudget, projectPanelText } from '../lib/context.mjs'
import { mergePanelStats } from '../lib/choices.mjs'
import { multiRoleFixture } from './fixtures/multi-role.mjs'

test('200 roles validate with sparse routes, empty stats and twelve panels', () => {
  const script = multiRoleFixture()
  script.turnPanels.panels = Array.from({length:12}, (_,i) => '面板' + i)
  assert.equal(validateScript(script).roles.length, 200)
  const parts = compileParts(script, createDraft(script))
  assert.equal(parts.initialStats['actor-0'].信任, 28)
  assert.equal(parts.initialStats['actor-1'].信任, 20)
  assert.equal(parts.initialStats['actor-1'].警觉, 0)
  assert.ok(!parts.rosterIndex.includes('人物100'))
  for (const role of script.roles) {
    assert.equal(parts.worldBook.filter(e => e.value.includes(role.profile)).length, 1)
    assert.ok(!parts.resident.includes(role.profile))
  }
  assert.equal(parts.rosterIndex.split('\n').filter(Boolean).length, 100)
  script.turnPanels.panels.push('第十三')
  assert.throws(() => validateScript(script), /1–12/)
})

test('sparse routes reject unknown ids, keys, invalid values and invalid cast policy', () => {
  for (const stats of [{ missing: { 信任: 2 } }, { 'actor-0': { 不存在: 2 } }, { 'actor-0': { 信任: 101 } }, { 'actor-0': { 信任: '20' } }]) {
    const s = multiRoleFixture(); s.routes[0].stats = stats
    assert.throws(() => validateScript(s))
  }
  for (const castPolicy of [{ maxOnStage: 0 }, { contextBudgetChars: '24000' }, { alwaysOnStage: ['不存在'] }, { alwaysOnStage: ['人物100'] }]) {
    const s = multiRoleFixture(); s.setting.castPolicy = castPolicy
    assert.throws(() => validateScript(s))
  }
  const legacy = multiRoleFixture(); legacy.routes[0].stats = { 'actor-0': [0, 5] }
  assert.deepEqual(validateScript(legacy).routes[0].stats['actor-0'], { 信任: 0, 警觉: 5 })
})

test('roster is stable, preserves order, clears on scene change, keeps mandatory roles and marks remote mentions', () => {
  const roles = multiRoleFixture().roles
  const options = { location: 'A市大学 / 图书馆', playerInput: '向别名9发消息', lastRoster: [], maxOnStage: 10, alwaysOnStage: ['actor-10'] }
  const result = resolveRoster(roles, options)
  assert.deepEqual(result, resolveRoster(roles, options))
  assert.equal(result[0].id, 'actor-10')
  assert.equal(result.find(r => r.id === 'actor-9').remote, true)
  const next = resolveRoster(roles, { ...options, previousLocation: options.location, location: 'C市港口', playerInput: '', lastRoster: result })
  assert.deepEqual(next, [{ id: 'actor-10', remote: false }])
  assert.deepEqual(resolveRoster(roles, { location: 'C市', playerInput: '人物100', lastRoster: [] }), [])
})

test('roster warnings report remote or absent people without altering the panels', () => {
  const roles = multiRoleFixture().roles
  const panels = [{ title: '在场名单', text: '人物000、人物009' }]
  assert.deepEqual(rosterWarnings(panels, roles, [{ id: 'actor-0', remote: false }, { id: 'actor-9', remote: true }]), ['本轮出现了不在场角色：人物009'])
  assert.equal(panels[0].text, '人物000、人物009')
})

test('worldbook uses character cost, group quotas, AND triggers and relevant fallback rather than a twelve-entry ceiling', () => {
  const entries = Array.from({length:30}, (_,i) => ({ key: '大学', tag: i < 15 ? '角色' : '场景', value: '设定条目' + i }))
  const loaded = matchWorldBook(entries, '大学', { maxChars: 2000, quotas: { 角色: 2 } })
  assert.equal(loaded.length, 17)
  assert.equal(loaded.filter(e => e.tag === '角色').length, 2)
  assert.deepEqual(matchWorldBook([{key:'_and_甲@wb@乙', tag:'规则', value:'条件'}], '甲'), [])
  assert.equal(matchWorldBook(entries, '', {maxChars:2000,minChars:100,fallbackText:'曾经在大学'}).length, 30)
  assert.deepEqual(matchWorldBook(entries, '', {maxChars:2000,minChars:100,fallbackText:'陌生地点'}), [])
  assert.deepEqual(matchWorldBook(entries, '大学', {maxChars:0}), [])
})

test('annotated stats normalize zero, negatives, arrows and preserve ordinary descriptions and sibling fields', () => {
  const previous = { 角色: { 小林: { 信任: 20, 警觉: 9 } } }
  const next = mergePanelStats(previous, { 角色: { 小林: { 信任:'0（-20）', 进度:'-3(+2)', 标记:'60→68', 描述:'2024年到校' } } })
  assert.deepEqual(next.角色.小林, { 信任:0, 警觉:9, 进度:-3, 标记:60, 描述:'2024年到校' })
  assert.equal(previous.角色.小林.信任, 20)
  assert.equal(mergePanelStats(null, { x: '0(+0)' }).x, 0)
})

test('ten simulated turns stay within the total budget and fifteen percent variation', () => {
  const script = validateScript(multiRoleFixture()), opening = compile(script, createDraft(script))
  let roster = [], panels = new Map(), ledger = {}, messages = []
  const lengths = []
  for (let turn = 0; turn < 10; turn++) {
    const prepared = prepareRequestRoster(opening, messages, roster, panels)
    assert.equal(prepared.roster.length, 8)
    if (turn) assert.deepEqual(prepared.roster, roster)
    roster = prepared.roster
    const request = customRequest(messages, panels, ledger, null, opening, roster)
    const system = request[0].content
    assert.ok(system.length <= 24000)
    for (const [k, size] of Object.entries(request.context.sizes)) assert.ok(size <= request.context.budget[k])
    assert.equal(system.includes('【开局初始数值】'), turn === 0)
    assert.ok(!system.includes('【引擎上下文v2】'))
    lengths.push(system.length)
    messages.push({role:'assistant', content:'大家在图书馆前继续交谈。'}, {role:'user',content:'我问人物000今天的安排。'})
    panels = new Map([['当前情况','地点：A市大学'], ['在场名单', '人物000至人物007']])
    ledger = Object.fromEntries(roster.map(r => [r.id, {信任:20+turn, 警觉:0}]))
  }
  assert.ok((Math.max(...lengths) - Math.min(...lengths)) / lengths[0] <= .15, JSON.stringify(lengths))
})

test('huge rules, panels and ledgers retain valid JSON and output protocol within each budget', () => {
  const script = multiRoleFixture()
  script.setting.castPolicy.contextBudgetChars = 4000
  script.setting.rule = '长规则。'.repeat(2000) + '\n\n最后规则甲。\n\n最后规则乙。'
  const opening = compile(validateScript(script), createDraft(script))
  const ledger = { 玩家: { 背包: Object.fromEntries(Array.from({length:1000},(_,i)=>['物品'+i,i])) }, 'actor-99': {信任:99} }
  const req = customRequest([{role:'assistant',content:'已经开始。'},{role:'user',content:'继续'}], new Map([['成员状态','人物099：不应发送\n人物000：现场\n' + '状态很长。'.repeat(2000)]]), ledger, null, opening)
  assert.ok(req[0].content.length <= 4000)
  assert.ok(req[0].content.includes('最后规则甲。'))
  assert.ok(req[0].content.includes('最后规则乙。'))
  assert.ok(req[0].content.includes('---PANEL-STATS---'))
  assert.ok(!req[0].content.includes('不应发送'))
  const json = req[0].content.split('【面板数值账本')[1].split('\n')[1]
  assert.doesNotThrow(() => JSON.parse(json))
  assert.ok(!json.includes('actor-99'))
  assert.doesNotThrow(() => JSON.parse(boundedJson(ledger, 70)))
})

test('legacy opening parsing removes full profiles from resident and recovers an explicit saved presence', () => {
  const old = '【剧本与世界观】\n测试\n地点：校园\n规则：规则\n\n【角色设定】\n小林：完整档案在这里。\n\n【玩家自定义档案】\n- 姓名：玩家\n\n【开局初始数值】\n小林·信任：20\n\n【开局场景：校园】\n小林在门口等你。\n【每轮输出协议】\n---PANEL---'
  const parts = parseOpening(old)
  assert.ok(parts.legacy)
  assert.ok(!parts.resident.includes('完整档案'))
  assert.equal(parts.worldBook[0].value, '小林：完整档案在这里。')
  assert.equal(prepareRequestRoster(old, [], [], new Map([['在场名单','小林']])).roster[0].remote, false)
  assert.equal(residentWithinBudget('短文本',20), '短文本')
})

test('new save roster round trips, old missing roster defaults and mismatched message pointers are discarded', () => {
  const base = { kind:'story-card-save',version:1,scriptId:'test',scriptTitle:'测试',player:{},messages:[{role:'assistant',content:'剧情。'}],panels:[],ledger:null,memory:null }
  assert.deepEqual(readStorySave(base).roster, [])
  const roster = [{id:'actor-1',remote:true}]
  assert.deepEqual(readStorySave({...base,roster,rosterAt:0}).roster, roster)
  assert.throws(()=>readStorySave({...base,roster,rosterAt:2}), /消息下标/)
  assert.deepEqual(readStorySave({...base,messages:[{role:'user',content:'继续'}],roster,rosterAt:0}).roster, [])
})

test('panel projection removes absent character paragraphs and their unnamed continuation lines', () => {
  const parts = { roles: [{id:'a',name:'小林'},{id:'b',name:'小陆'}] }
  const value = '小陆：留在宿舍\n私下状态不应进入现场基准\n\n小林：在场\n正在查看书架\n\n天气：晴'
  assert.equal(projectPanelText(value, parts, [{id:'a',remote:false}]), '小林：在场\n正在查看书架\n\n天气：晴')
})
