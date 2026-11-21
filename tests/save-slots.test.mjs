import assert from 'node:assert/strict'
import test from 'node:test'
import { changeSaveSlot, getSaveSlot, listSaveSlots, saveSlotCount } from '../lib/save-slots.mjs'

function memoryIndexedDB() {
  const records = new Map()
  const db = {
    createObjectStore() {},
    close() {},
    transaction() {
      let pending = 0
      function schedule(run) {
        pending++
        queueMicrotask(() => {
          run()
          if (--pending === 0) tx.oncomplete()
        })
      }
      function request(read) {
        const response = {}
        schedule(() => {
          response.result = read()
          response.onsuccess?.()
        })
        return response
      }
      const store = {
        get: slot => request(() => structuredClone(records.get(slot))),
        put: save => request(() => records.set(save.slot, structuredClone(save))),
        delete: slot => request(() => records.delete(slot)),
        openCursor({ lower, upper }) {
          const rows = [...records].filter(([slot]) => slot >= lower && slot <= upper)
            .sort(([a], [b]) => a - b)
          const response = {}
          function advance() {
            schedule(() => {
              const next = rows.shift()
              response.result = next ? { value: structuredClone(next[1]), continue: advance } : null
              response.onsuccess()
            })
          }
          advance()
          return response
        }
      }
      const tx = { objectStore: () => store }
      return tx
    }
  }
  return {
    open() {
      const request = { result: db }
      queueMicrotask(() => request.onsuccess())
      return request
    }
  }
}

const save = (name = '排练线') => ({
  name, savedAt: '2026-11-08T03:00:00Z', scriptId: 'prism-draft', scriptTitle: 'PRISM', turns: 1,
  player: { name: '林晚棠' }, messages: [{ role: 'user', content: '开局' }],
  panels: new Map([['当前情况', '排练室']]),
  ledger: { day: 2, dayStart: { 玩家: 850 }, members: { 玩家: { popularity: 890 } } },
  memory: { recent: [], archive: [], nextId: 1 }
})

function stubStorage(t) {
  for (const [name, value] of Object.entries({
    indexedDB: memoryIndexedDB(),
    IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) }
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else delete globalThis[name]
    })
  }
}

test('only slots 1 through 16 can be written, and the slot list stays sorted', async t => {
  stubStorage(t)
  assert.equal(saveSlotCount, 16)
  assert.throws(() => changeSaveSlot(17, null, { kind: 'save', save: save() }), /1 至 16/)
  assert.throws(() => getSaveSlot(0), /1 至 16/)
  for (let slot = 16; slot >= 1; slot--) {
    assert.equal(await changeSaveSlot(slot, null, { kind: 'save', save: save() }), true)
  }
  assert.deepEqual((await listSaveSlots()).map(entry => entry.slot), Array.from({ length: 16 }, (_, i) => i + 1))
})

test('slots serialize panels, retain the daily baseline, and support overwrite, rename and delete', async t => {
  stubStorage(t)
  assert.equal(await changeSaveSlot(2, null, { kind: 'save', save: save() }), true)
  const first = await getSaveSlot(2)
  assert.deepEqual(first.panels, [['当前情况', '排练室']])
  assert.deepEqual(first.ledger.dayStart, { 玩家: 850 })
  assert.equal(await changeSaveSlot(2, first, { kind: 'rename', name: '已改名' }), true)
  const renamed = await getSaveSlot(2)
  assert.deepEqual(renamed, { ...first, name: '已改名' })
  assert.equal(await changeSaveSlot(2, first, { kind: 'delete' }), false)
  assert.equal(await changeSaveSlot(2, renamed, { kind: 'save', save: save('覆盖') }), true)
  assert.deepEqual((await listSaveSlots()).map(entry => [entry.slot, entry.name]), [[2, '覆盖']])
  assert.equal(await changeSaveSlot(2, await getSaveSlot(2), { kind: 'delete' }), true)
  assert.equal(await getSaveSlot(2), undefined)
})
