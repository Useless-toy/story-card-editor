import assert from 'node:assert/strict'
import test from 'node:test'
import { checkStaticRoutes } from '../lib/static-check.mjs'

test('startup checks missing assets and unregistered HTML and transitive module routes', async () => {
  const routes = new Map([
    ['/', ['index.html']], ['/index.html', ['index.html']],
    ['/chat.js', ['chat.js']], ['/lib/slots.mjs', ['lib/slots.mjs']],
    ['/chat.css', ['chat.css']], ['/missing.css', ['missing.css']]
  ])
  const files = new Map([
    ['index.html', '<script type="module" src="./chat.js"></script><link rel="stylesheet" href="/old.css">'],
    ['chat.js', 'import { slots } from "./lib/slots.mjs"\nimport "./chat.css"\nimport("./lazy.mjs?x=1")'],
    ['lib/slots.mjs', 'export { normalize } from "../helpers.mjs"\nimport "https://example.invalid/external.mjs"'],
    ['chat.css', '']
  ])
  const read = async file => {
    if (!files.has(file)) throw new Error('missing')
    return files.get(file)
  }
  assert.deepEqual(await checkStaticRoutes(routes, read), [
    '登记的静态文件不存在或无法读取：/missing.css → missing.css',
    '页面引用未登记路由：index.html → /old.css',
    '页面引用未登记路由：chat.js → /lazy.mjs',
    '页面引用未登记路由：lib/slots.mjs → /helpers.mjs'
  ])
  for (const file of ['old.css', 'lazy.mjs', 'helpers.mjs', 'missing.css']) {
    routes.set('/' + file, [file])
    files.set(file, '')
  }
  assert.deepEqual(await checkStaticRoutes(routes, read), [])
})
