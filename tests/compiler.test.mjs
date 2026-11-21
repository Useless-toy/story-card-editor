import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compile, createDraft, validateScript } from '../compiler.mjs'
const script = validateScript(JSON.parse(await readFile(new URL('./fixtures/minimal.json', import.meta.url))))

test('PRISM has three fixed openings and generates a fresh seed for a random opening', async () => {
  const prism = validateScript(JSON.parse(await readFile(new URL('./fixtures/ledger-cast.json', import.meta.url))))
  const fixed = prism.routes.filter(route => !route.custom)
  assert.equal(fixed.length, 3)
  assert.equal(new Set(fixed.map(route => route.scene)).size, 3)
  for (const route of fixed) {
    const draft = createDraft(prism, { routeId: route.id })
    assert.ok(compile(prism, draft, { random: () => { throw new Error('fixed route does not roll') } }).includes(route.scene))
  }
  const oldRoutes = [fixed[0], { id: 'custom', custom: true, name: '自定义开场' }]
  const draft = createDraft(prism, { routes: oldRoutes, routeId: 'custom', customScene: '偏队友合作' })
  assert.deepEqual(draft.routes.map(route => route.id), ['briefing', 'live-slot', 'rough-cut', 'custom'])
  const preview = compile(prism, draft)
  const a = compile(prism, draft, { random: () => 0 })
  const b = compile(prism, draft, { random: () => 0.8 })
  assert.doesNotMatch(preview, /本局抽到的开场线索/)
  assert.match(a, /本局抽到的开场线索：临时录音间/)
  assert.match(b, /本局抽到的开场线索：凌晨便利店/)
  assert.match(a, /玩家提供的可选方向：偏队友合作/)
})
test('routes compile exact scenes, distinct stats, setting and state protocol', () => {
  const draft = createDraft(script)
  draft.player.name = '小周'
  const output = compile(script, draft)
  assert.match(output, /姓名：小周/)
  assert.ok(output.includes(script.roles[0].profile))
  assert.ok(output.includes(script.routes[0].scene))
  assert.match(output, /每一次回复的开头/)
  const next = compile(script, { ...draft, routeId: script.routes[1].id, toggleOn: true })
  assert.notEqual(output.split('【开局初始数值】')[1], next.split('【开局初始数值】')[1])
  assert.ok(next.includes(script.toggle.optionDesc))
})
test('custom scene stays verbatim and model selection does not change text', () => {
  const draft = { ...createDraft(script), routeId: 'route4', customScene: '  海风停了。\n\n灯仍亮着。  ' }
  const output = compile(script, draft)
  assert.ok(output.includes(draft.customScene))
  assert.match(output, /自动推演角色的反应与初始数值/)
  assert.equal(compile(script, { ...draft, selectedModel: 'test' }), output)
})
test('rejects invalid route stats', () => {
  const invalid = structuredClone(script)
  invalid.routes[0].stats[invalid.roles[0].id][invalid.roles[0].stats[0].key] = 101
  assert.throws(() => validateScript(invalid), /0–100/)
})

test('legacy scripts migrate and preserve route numbers without modifying the JSON files', async () => {
  for (const rel of ['./fixtures/minimal.json', '../scripts/apartment.json']) {
    const original = JSON.parse(await readFile(new URL(rel, import.meta.url)))
    const expected = original.routes[0].stats[original.roles[0].id]
    const migrated = validateScript(original)
    assert.deepEqual(Object.values(migrated.routes[0].stats[migrated.roles[0].id]), expected)
    assert.match(compile(migrated, createDraft(migrated)), /---CHOICES---/)
  }
})
test('one role with four keyed stats, or six roles, compiles', () => {
  const single = structuredClone(script)
  single.roles = single.roles.slice(0, 1)
  const role = single.roles[0]
  role.stats = ['甲','乙','丙','丁'].map((key, index) => ({ key, default: index }))
  for (const route of single.routes.filter(route => !route.custom)) route.stats = {
    [role.id]: { 丁: 44, 丙: 33, 乙: 22, 甲: 11 }
  }
  validateScript(single)
  assert.ok(compile(single, createDraft(single)).includes(role.name + '·丁：44'))
  const six = structuredClone(single)
  six.roles = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(role), id: 'role-' + i, name: '角色' + i }))
  for (const route of six.routes.filter(route => !route.custom)) route.stats = Object.fromEntries(six.roles.map(r => [r.id, { 甲: 1, 乙: 2, 丙: 3, 丁: 4 }]))
  validateScript(six)
  assert.ok(compile(six, createDraft(six)).includes('角色5·丁：4'))
})
test('custom instruction, variable player fields and draft world override', () => {
  const variable = structuredClone(script)
  variable.playerFields = [{ key: 'goal', label: '目标', type: 'text' }]
  variable.choiceInstruction = '用克制的侦探语气写出选项。'
  validateScript(variable)
  const draft = createDraft(variable, { player: { goal: '回港' }, setting: { ...variable.setting, rule: '日落前回来。' } })
  const output = compile(variable, draft)
  assert.match(output, /规则：日落前回来。/)
  assert.match(output, /目标：回港/)
  assert.match(output, /【每轮输出格式】[\s\S]*---CHOICES---[\s\S]*侦探语气/)
  assert.throws(() => compile(variable, { ...draft, setting: { ...draft.setting, rule: '' } }), /规则不能为空/)
})

