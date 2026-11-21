import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compile, createDraft, prismRequest, readStorySave, readStoryTranscript, validateScript } from '../compiler.mjs'

const loadFixture = name => validateScript(JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url))))
const prism = loadFixture('ledger-cast')
const minimal = loadFixture('minimal')
const exportText = (script, messages) => messages.map(({ role, content }) =>
  '【' + (role === 'user' ? '玩家' : script.title) + '】\n' + content).join('\n\n---\n\n')

test('legacy PRISM text restores the original profile, ledger, panels and memory for the next request', () => {
  const opening = compile(prism, createDraft(prism, { player: { name: '林晚棠', background: '旧档第一行\n旧档第二行' } }))
  const reply = [
    '陆星晚递来排练表。', '---PRISM---', '【当前情况】', '练习室',
    '【工作记忆】', '[1] 【公开】北门的排练改期。', '【PRISM-STATS】',
    '{"day":1,"members":{"陆星晚":{"affection":25,"affectionReason":"一起对拍"},"玩家":{"popularity":900}}}',
    '---CHOICES---', '【排练】去练习室'
  ].join('\n')
  const messages = [{ role: 'user', content: opening }, { role: 'assistant', content: reply },
    { role: 'user', content: '我去练习室。' }, { role: 'assistant', content: '改期通知已经发出。' }]
  const file = '\uFEFF' + exportText(prism, messages).replace(/\r?\n/g, '\r\n')
  const restored = readStoryTranscript(file, [minimal, prism], minimal.id)
  const save = readStorySave(JSON.parse(JSON.stringify(restored.save)))
  assert.equal(save.scriptId, prism.id)
  assert.equal(save.player.name, '林晚棠')
  assert.equal(save.player.background, '旧档第一行\n旧档第二行')
  assert.equal(save.ledger.members.陆星晚.affection, 25)
  assert.equal(save.ledger.members.玩家.popularity, 900)
  assert.equal(save.panels.get('当前情况'), '练习室')
  assert.equal(save.memory.recent[0].text, '【公开】北门的排练改期。')
  assert.equal(restored.missingLedgerTurns, 1)
  const request = prismRequest([...save.messages, { role: 'user', content: '我去看排练。' }], save.panels, save.ledger, save.memory)
  assert.match(request[0].content, /"affection":25/)
  assert.equal(request.at(-2).content, '改期通知已经发出。')
})

test('legacy ordinary text preserves prose separators, choice labels and a pending user message', () => {
  const opening = compile(minimal, createDraft(minimal)).trim()
  const reply = '海风停了。\n\n---\n\n【场景】\n灯还亮着。\n---CHOICES---\n① 出门看看'
  const messages = [{ role: 'user', content: opening }, { role: 'assistant', content: reply }, { role: 'user', content: '我出门。' }]
  const save = readStorySave(readStoryTranscript(exportText(minimal, messages), [minimal], minimal.id).save)
  assert.deepEqual(save.messages, messages)
  assert.equal(save.ledger, null)
  assert.throws(() => readStoryTranscript('随手写的笔记。', [minimal]), /导出记录/)
})
