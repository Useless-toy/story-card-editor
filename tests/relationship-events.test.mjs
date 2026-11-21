import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compile, createDraft, prismRequest, readStorySave, settlePrismTurn, startLedger } from '../compiler.mjs'
import { splitPrismTurn } from '../lib/choices.mjs'

const script = JSON.parse(readFileSync(new URL('./fixtures/ledger-cast.json', import.meta.url)))
const opening = compile(script, createDraft(script))
const initial = () => ({ recent: [], archive: [], nextId: 1 })
const asTurn = (body, stats, panel = '') => splitPrismTurn(
  body + '\n---PRISM---\n' + panel + '\n【PRISM-STATS】\n' + JSON.stringify(stats))

test('a confirmed relationship milestone settles a missing proposal once and survives archive compression', () => {
  const ledger = startLedger(script.prismStats)
  const memory = { ...initial(), recent: [
    { id: 1, text: '【公开】06:00打歌彩排与直播待办。' },
    { id: 2, text: '【公开】确认舞台名单。' },
    { id: 3, text: '【公开】排练结束。' },
    { id: 4, text: '【公开】取通行证。' }
  ], nextId: 5 }
  const body = '你和陆星晚第一次接吻。'
  const event = { name: '陆星晚', type: 'first-kiss', fact: '两人私下确认彼此心意。', evidence: body }
  let next = settlePrismTurn(memory, ledger, asTurn(body, { day: 1, relationshipEvents: [event] }))
  assert.equal(next.ledger.members.陆星晚.affection, 25)
  assert.match(next.warnings[0], /补结算/)
  const [unrelatedScene] = prismRequest([{ role: 'user', content: opening }, { role: 'user', content: '去找姜柔。' }],
    new Map(), next.ledger, next.memory)
  assert.doesNotMatch(unrelatedScene.content, /两人私下确认彼此心意/)
  const after = settlePrismTurn(next.memory, next.ledger, asTurn('两人回去排练。', { day: 1,
    relationshipEvents: [event], members: { 陆星晚: { affection: 30, affectionReason: '回忆了初吻' } } }))
  assert.equal(after.ledger.members.陆星晚.affection, 25)
  for (const fact of ['签到', '核对话筒', '上台', '谢幕']) {
    next = settlePrismTurn(next.memory, next.ledger,
      asTurn(fact + '。', { day: 1 }, '【工作记忆】\n[1] 【公开】' + fact))
  }
  const archived = next.memory.archive.find(entry => entry.sources?.some(source => source.text.includes('首次接吻')))
  assert.match(archived.text, /^陆星晚 · 首次接吻/)
  assert.match(archived.sources.find(source => source.text.includes('首次接吻')).text, /【知情：玩家、陆星晚】/)
  const messages = [{ role: 'user', content: opening }, { role: 'assistant', content: body, warnings: ['已补结算。'] }]
  const save = readStorySave(JSON.parse(JSON.stringify({ kind: 'story-card-save', version: 1, scriptId: script.id,
    scriptTitle: script.title, player: {}, messages, panels: [], ledger: next.ledger, memory: next.memory })))
  assert.deepEqual(save.ledger.milestones, ['first-kiss:陆星晚'])
  const [system, ...rest] = prismRequest([...save.messages, { role: 'user', content: '去找姜柔。' }], save.panels, save.ledger, save.memory)
  assert.doesNotMatch(system.content, /first-kiss:陆星晚|两人私下确认彼此心意/)
  assert.ok(rest.every(message => !message.warnings))
})

test('an unconfirmed keyword warns without changing affection, while a confirmed rupture decreases it', () => {
  const ledger = startLedger(script.prismStats)
  const body = '陆星晚宣布和你决裂。'
  const suspect = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1 }))
  assert.equal(suspect.ledger.members.陆星晚.affection, 20)
  assert.match(suspect.warnings[0], /请核对/)
  const rupture = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1,
    relationshipEvents: [{ name: '陆星晚', type: 'rupture', fact: '陆星晚结束两人的合作。', evidence: body }] }))
  assert.equal(rupture.ledger.members.陆星晚.affection, 14)
  const memory = settlePrismTurn(initial(), ledger, asTurn('陆星晚想起两人第一次接吻。', { day: 1 }))
  assert.deepEqual(memory.warnings, [])
})

test('a public declaration can use an exact quote without repeating the speaker’s name', () => {
  const quote = '「我支持这个提案。如果需要队内意见，我赞成。」'
  const body = '姜柔正要开口，陆星晚先拿起话筒。\n\n' + quote
  const event = { name: '陆星晚', type: 'public-support', fact: '她在记者会上支持了舞台提案。', evidence: quote, public: true }
  const ledger = startLedger(script.prismStats)
  const next = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [event] }))
  assert.equal(next.ledger.members.陆星晚.affection, 23)
  assert.match(next.memory.recent[0].text, /^【公开】【里程碑】/)
  const wrong = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [{ ...event, name: '姜柔' }] }))
  assert.equal(wrong.ledger.members.姜柔.affection, 20)
  const excerpt = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1,
    relationshipEvents: [{ ...event, evidence: '陆星晚先拿起话筒……「我支持这个提案。' }] }))
  assert.equal(excerpt.ledger.members.陆星晚.affection, 23)
})

test('public acknowledgment of an existing agreement is covered on old saves and flagged when omitted', () => {
  const ledger = startLedger(script.prismStats)
  const oldOpening = opening.split('\n').filter(line => !line.startsWith('【公开支持补充】') &&
    !line.startsWith('提前公开、兑现已有约定')).join('\n')
  const [request] = prismRequest([{ role: 'user', content: oldOpening }], new Map(), ledger, initial())
  assert.match(request.content, /【公开支持补充】[^\n]*当众承认与玩家的约定或关系/)
  const body = '陆星晚说：“晚棠跟我一起走，已经定了。”整个待机室都听见了。'
  const omitted = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [] }))
  assert.equal(omitted.ledger.members.陆星晚.affection, 20)
  assert.match(omitted.warnings[0], /关系结算漏检.*未提交 relationshipEvents/)
  const next = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [
    { name: '陆星晚', type: 'public-support', fact: '她当众承认两人一起走的约定。', evidence: body, public: true }
  ], members: { 陆星晚: { affection: 23 } } }))
  assert.equal(next.ledger.members.陆星晚.affection, 23)
  assert.deepEqual(next.warnings, [])
  assert.match(next.memory.recent[0].text, /首次公开支持/)
  const formatted = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [
    { name: '陆星晚', type: 'public-support', fact: '她当众确认同行。',
      evidence: '陆星晚：「晚棠跟我一起走，已经定了。」／「定了。」', public: true }
  ] }))
  assert.equal(formatted.ledger.members.陆星晚.affection, 23)
  assert.match(formatted.memory.recent[0].text, /当众确认同行/)
  const quoteOnly = settlePrismTurn(initial(), ledger, asTurn(body, { day: 1, relationshipEvents: [
    { name: '陆星晚', type: 'public-support', fact: '她当众确认同行。',
      evidence: '「晚棠跟我一起走，已经定了」', public: true }
  ] }))
  assert.equal(quoteOnly.ledger.members.陆星晚.affection, 23)
})
