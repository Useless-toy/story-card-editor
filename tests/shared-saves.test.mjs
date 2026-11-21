import assert from 'node:assert/strict'
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSharedSaves } from '../lib/shared-saves.mjs'

const save = {
  kind: 'story-card-save', version: 1, name: '手机进度', scriptId: 'prism-draft', scriptTitle: 'PRISM', player: {},
  messages: [{ role: 'user', content: '【PRISM 每轮状态协议】' }, { role: 'assistant', content: '排练开始。' }],
  panels: [['当前情况', '练习室']],
  ledger: { day: 2, dayStart: { 玩家: 850 }, members: { 玩家: { popularity: 900, soloFans: 1200, passers: 12, cpFans: 0 } }, pairs: {} },
  memory: { recent: [{ id: 1, text: '【公开】公开排练开始。' }], archive: [], nextId: 2 }
}

test('shared slots preserve full state across restarts and reject competing writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'prism-shared-saves-'))
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file))
    await rmdir(directory)
  })
  const first = createSharedSaves(directory)
  assert.deepEqual(await first.list(), [])
  await first.change(16, null, { kind: 'save', save })
  const restarted = createSharedSaves(directory)
  const original = await restarted.get(16)
  assert.deepEqual(original.panels, save.panels)
  assert.deepEqual(original.memory, save.memory)
  assert.deepEqual(original.ledger.dayStart, { 玩家: 850 })
  assert.equal(original.turns, 1)

  const competing = await Promise.allSettled([
    restarted.change(16, original.revision, { kind: 'rename', name: '电脑改名' }),
    restarted.change(16, original.revision, { kind: 'delete' })
  ])
  assert.equal(competing[0].status, 'fulfilled')
  assert.equal(competing[1].reason.status, 409)
  const renamed = await restarted.get(16)
  const { revision, name, ...unchanged } = renamed
  const { revision: oldRevision, name: oldName, ...oldState } = original
  assert.equal(name, '电脑改名')
  assert.notEqual(revision, oldRevision)
  assert.deepEqual(unchanged, oldState)
  assert.deepEqual((await restarted.list()).map(item => item.slot), [16])
  await assert.rejects(restarted.change(17, null, { kind: 'save', save }), { status: 400 })
  await assert.rejects(restarted.change(1, null, { kind: 'save', save: { ...save, messages: [] } }), { status: 400 })
  await restarted.change(16, revision, { kind: 'delete' })
  assert.equal(await createSharedSaves(directory).get(16), null)
})

test('shared custom saves retain the numerical ledger and roster across a server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'multi-role-shared-'))
  t.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory,file))
    await rmdir(directory)
  })
  const custom = { ...save, scriptId:'test', scriptTitle:'多人测试', opening:'【剧本与世界观】\n多人测试',
    messages:[{role:'assistant',content:'场景开始。'}], panels:[['在场名单','小林']],
    ledger:null,memory:null,panelsMode:'custom',panelState:{角色:{小林:{信任:60}}},roster:[{id:'lin',remote:false}],rosterAt:0,rosterLocation:'大学' }
  await createSharedSaves(directory).change(1,null,{kind:'save',save:custom})
  const restored=await createSharedSaves(directory).get(1)
  for(const field of ['panelState','panelsMode','roster','rosterAt','rosterLocation']) assert.deepEqual(restored[field],custom[field])
})
