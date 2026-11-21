import assert from 'node:assert/strict'
import test from 'node:test'
import { splitChoices, splitPrismTurn, updatePrismMemory } from '../lib/choices.mjs'

test('recognized delimiters separate body and preserve five choices', () => {
  for (const mark of ['---CHOICES','---CHOICES---','--- CHOICES ---','【CHOICES】']) {
    assert.deepEqual(splitChoices('正文。\r\n' + mark + '\r\n① 查看地图\n2. 打开门\n- 去休息\n④ 等待\n⑤ 找队友'), {
      body: '正文。', choices: ['查看地图', '打开门', '去休息', '等待', '找队友']
    })
  }
})
test('no marker leaves the body unchanged, and short lists are valid', () => {
  const body = '正文① 查看地图 ② 打开门\n'
  assert.deepEqual(splitChoices(body), { body, choices: [] })
  assert.deepEqual(splitChoices('正文\n---CHOICES---\n① 留下\n② 出门'), { body: '正文', choices: ['留下', '出门'] })
})


test('PRISM separates narrative, updates changed panels and marks carried data', () => {
  const opening = splitPrismTurn('她在门口停下。\n---PRISM---\n【队友关系】\n许恩霏：20\n【PRISM·成员状态】\n人气：850')
  const previous = new Map(opening.panels.filter(panel => panel.text).map(panel => [panel.title, panel.text]))
  const next = splitPrismTurn('她递来了热可可。\n---PRISM---\n【队友关系】\n许恩霏：23（+3）\n---CHOICES---\n① 问她书店地址')
  const updated = splitPrismTurn('她递来了热可可。\n---PRISM---\n【队友关系】\n许恩霏：23（+3）\n---CHOICES---\n① 问她书店地址', previous)
  assert.equal(next.body, '她递来了热可可。')
  assert.deepEqual(updated.choices, ['问她书店地址'])
  assert.equal(updated.panels.find(panel => panel.title === '队友关系').text, '许恩霏：23（+3）')
  assert.deepEqual(updated.panels.find(panel => panel.title === 'PRISM·成员状态'), {
    title: 'PRISM·成员状态', text: '人气：850', carried: true
  })
})

test('PRISM recovers all panels when the model omits the PRISM and CHOICES markers', () => {
  const sections = [
    ['【当前情况】', '凌晨，练习室。'],
    ['### **【成员状态】**', '人气 850'],
    ['【队友关系】', '许恩霏好感 23'],
    ['【团内 CP 热度榜】', '柔晚 8200'],
    ['【工作日程与本周事件】', '11/15 打歌'],
    ['【工作记忆】', '镜头改为全景'],
    ['【历史档案】', '出道第二年']
  ]
  const raw = ['她把热可可放在桌上。', ...sections.flat(), '【行动推荐】', '1. 再练一遍', '② 回宿舍'].join('\r\n')
  const result = splitPrismTurn(raw)
  assert.equal(result.body, '她把热可可放在桌上。')
  assert.deepEqual(result.panels.map(panel => panel.text), sections.map(([, value]) => value))
  assert.deepEqual(result.choices, ['再练一遍', '回宿舍'])
})


test('PRISM accepts the observed open-ended delimiters without losing stats or memory', () => {
  const raw = ['正文。', '---PRISM---', '【工作记忆】', '[1] 完成排练',
    '---PRISM-STATS', '{"day":1,"members":{"玩家":{"popularity":860}}}',
    '---CHOICES', '【社交】a', '【个人】b', '【排练】c', '【休息】d', '【查看】e'].join('\r\n')
  const result = splitPrismTurn(raw)
  assert.equal(result.body, '正文。')
  assert.equal(result.panels.find(panel => panel.title === '工作记忆').text, '[1] 完成排练')
  assert.equal(result.stats.members.玩家.popularity, 860)
  assert.deepEqual(result.choices, ['【社交】a', '【个人】b', '【排练】c', '【休息】d', '【查看】e'])
})


test('memory dedupe ignores punctuation and spacing and compares the first 24 characters', () => {
  const memory = { recent: [], archive: [], nextId: 1 }
  const withPanel = (state, line) => updatePrismMemory(state, [{ title: '工作记忆', text: '[1] ' + line }]).memory
  // 实测里同一件事被存成 [19][23][25] 三份，差别只是句尾标点和空格。
  const first = withPanel(memory, '苏暖问许恩霏今晚是否回来睡。')
  assert.equal(first.recent.length, 1)
  const second = withPanel(first, '苏暖问许恩霏今晚是否回来睡？')
  assert.equal(second.recent.length, 1)
  const third = withPanel(second, '苏暖问，许恩霏今晚 是否 回来睡！')
  assert.equal(third.recent.length, 1)
  // 两条都超过 24 字且前缀相同（叙述里常见：同一件事补一句后续），只算一条。
  const prefix = '陆星晚在练习室确认今晚副歌走位要重新顺一遍以后再说'
  const fourth = withPanel(third, prefix + '，她先去补录口播。')
  assert.equal(fourth.recent.length, 2)
  const fifth = withPanel(fourth, prefix + '，她直接回宿舍。')
  assert.equal(fifth.recent.length, 2)
  // 日期落在前 24 字里，不会被误判成同一条。
  const dated = withPanel(fifth, '11/16 ' + prefix + '，她先去补录口播。')
  assert.equal(dated.recent.length, 3)
  // 真正不同的新事实照常入库。
  const fresh = withPanel(dated, '沈以岚把待机室的门锁换了。')
  assert.equal(fresh.recent.length, 4)
  // 已经写进历史档案的事实也不再重复追加。
  const moved = { ...fresh, recent: fresh.recent.slice(1), archive: [fresh.recent[0]] }
  const archived = withPanel(moved, '苏暖问许恩霏今晚是否回来睡')
  assert.equal(archived.recent.length, 3)
  assert.equal(archived.archive.length, 1)
})
