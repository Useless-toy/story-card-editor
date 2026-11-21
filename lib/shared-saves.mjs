import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readStorySave } from '../compiler.mjs'
import { saveSlotCount } from './save-slots.mjs'

export class SaveSlotError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function createSharedSaves(directory) {
  let tail = Promise.resolve()
  const serial = work => {
    const result = tail.then(work)
    tail = result.catch(() => {})
    return result
  }

  function pathFor(slot) {
    if (!Number.isInteger(slot) || slot < 1 || slot > saveSlotCount) {
      throw new SaveSlotError(400, '存档槽位必须为 1 至 16。')
    }
    return join(directory, 'slot-' + slot + '.json')
  }

  async function readSlot(slot) {
    try {
      return JSON.parse(await readFile(pathFor(slot), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  function saveName(value) {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 30) {
      throw new SaveSlotError(400, '存档名称须为 1 至 30 字。')
    }
    return value.trim()
  }

  function buildSave(raw) {
    try {
      const { kind, version, scriptId, scriptTitle, player, prism, messages, panels, ledger, memory, opening, panelState, panelsMode, roster, rosterAt, rosterLocation } = readStorySave(raw)
      return { kind, version, scriptId, scriptTitle, player, prism, messages, panels: [...panels], ledger, memory, opening,
        panelState, panelsMode, roster, rosterAt, rosterLocation,
        turns: messages.filter(message => message.role === 'assistant').length }
    } catch (error) {
      throw new SaveSlotError(400, error.message)
    }
  }

  return {
    list: () => serial(async () => {
      const slots = []
      for (let slot = 1; slot <= saveSlotCount; slot++) {
        const save = await readSlot(slot)
        if (!save) continue
        const { name, savedAt, scriptId, scriptTitle, turns, revision } = save
        slots.push({ slot, name, savedAt, scriptId, scriptTitle, turns, revision })
      }
      return slots
    }),
    get: slot => serial(() => readSlot(slot)),
    change: (slot, expected, operation) => serial(async () => {
      const path = pathFor(slot)
      if (!['save', 'rename', 'delete'].includes(operation?.kind) ||
          (expected !== null && typeof expected !== 'string')) throw new SaveSlotError(400, '无效的存档操作。')
      const current = await readSlot(slot)
      if ((current?.revision ?? null) !== expected) throw new SaveSlotError(409, '该槽位已在其他设备修改，请刷新后再试。')
      if (operation.kind !== 'save' && !current) throw new SaveSlotError(404, '该槽位没有存档。')
      if (operation.kind === 'delete') {
        await unlink(path)
        return
      }
      const revision = randomUUID()
      const next = operation.kind === 'rename'
        ? { ...current, name: saveName(operation.name), revision }
        : { ...buildSave(operation.save), slot, name: saveName(operation.save?.name), savedAt: new Date().toISOString(), revision }
      await mkdir(directory, { recursive: true })
      const temporary = join(directory, '.slot-' + slot + '-' + revision + '.tmp')
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx' })
        await rename(temporary, path)
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
    })
  }
}
