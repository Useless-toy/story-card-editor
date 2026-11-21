export const saveSlotCount = 16
const databaseName = 'story-card-saves'
const storeName = 'slots'

function checkSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > saveSlotCount) throw new Error('存档槽位必须为 1 至 16。')
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'slot' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(mode, work) {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      let result
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? new Error('存档操作未完成。'))
      work(tx.objectStore(storeName), value => { result = value })
    })
  } finally {
    db.close()
  }
}

export function listSaveSlots() {
  return transact('readonly', (store, done) => {
    const entries = []
    const request = store.openCursor(IDBKeyRange.bound(1, saveSlotCount))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return done(entries)
      const { slot, name, savedAt, scriptId, scriptTitle, turns } = cursor.value
      entries.push({ slot, name, savedAt, scriptId, scriptTitle, turns })
      cursor.continue()
    }
  })
}

export function getSaveSlot(slot) {
  checkSlot(slot)
  return transact('readonly', (store, done) => {
    const request = store.get(slot)
    request.onsuccess = () => done(request.result)
  })
}

export function changeSaveSlot(slot, expected, operation) {
  checkSlot(slot)
  const save = operation.kind === 'save' ? { ...operation.save, panels: [...operation.save.panels], slot } : null
  return transact('readwrite', (store, done) => {
    const request = store.get(slot)
    request.onsuccess = () => {
      const current = request.result
      if (current?.savedAt !== expected?.savedAt || current?.name !== expected?.name) return done(false)
      if (operation.kind === 'delete') store.delete(slot)
      if (operation.kind === 'rename' && current) store.put({ ...current, name: operation.name })
      if (save) store.put(save)
      done(true)
    }
  })
}

const sharedPath = './api/save-slots'

async function requestShared(path, options) {
  const response = await fetch(path, options)
  if (response.status === 409) return false
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error('共享存档服务未就绪，请在主机上重启游戏服务。')
  }
  if (!response.ok) throw new Error(data.error || '共享存档操作失败。')
  return data
}

export const listSharedSlots = () => requestShared(sharedPath)
export const getSharedSlot = slot => requestShared(sharedPath + '/' + slot)

export function changeSharedSlot(slot, expected, operation) {
  checkSlot(slot)
  const next = operation.kind === 'save'
    ? { ...operation, save: { ...operation.save, panels: [...operation.save.panels] } }
    : operation
  return requestShared(sharedPath + '/' + slot, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected: expected?.revision ?? null, operation: next })
  })
}
