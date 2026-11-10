/**
 * Client-half smoke test: load client.js the way the Web module loader does,
 * register the settings section into a fake slot table, then render the panel
 * with a mocked host and exercise the save button.
 *
 * Run with: node test/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
TestRenderer.act && (globalThis.IS_REACT_ACT_ENVIRONMENT = true)

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

const calls = []
globalThis.fetch = async (url, options) => {
  calls.push({ url, options })
  if (url === '/qgent/status') {
    return { ok: true, status: 200, json: async () => ({ connected: true, appId: '190600', error: '', profile: 'C:/x' }) }
  }
  if (url === '/qgent/config') {
    const config = {
      appId: '190600', provider: '', model: '', preset: '', requireMention: false,
      streaming: false, showToolResults: false, groupPrompt: '群人设', directPrompt: '',
      access: { c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] },
      debug: false, mode: 'steer', fallbackReply: true,
    }
    if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, message: '配置已保存，qgent 将自动重载' }) }
    return { ok: true, status: 200, json: async () => ({ config }) }
  }
  throw new Error(`unexpected fetch: ${url}`)
}

await import('../client.js')

assert.equal(captured?.id, 'dsh-qgent', 'client module id must equal the package name')
assert.equal(typeof captured.factory, 'function')

const client = captured.factory(specifier => {
  if (specifier === 'react') return React
  return require(specifier)
})
assert.deepEqual(client.inject, ['slots'])

let registered
const ctx = {
  slots: {
    inject(name, install) {
      assert.equal(name, 'settings.section')
      install()
      return () => {}
    },
    register(definition, component) {
      registered = { definition, component }
      return () => {}
    },
  },
}
client.apply(ctx)
assert.equal(registered?.definition.name, 'settings.section')
assert.equal(registered?.definition.id, 'qgent')
assert.equal(registered?.definition.label, 'QQ 机器人')

let renderer
await TestRenderer.act(async () => {
  renderer = TestRenderer.create(React.createElement(registered.component))
})
// Let the two fetches settle.
await TestRenderer.act(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
})

const tree = renderer.toJSON()
const text = JSON.stringify(tree)
assert.ok(text.includes('QQ 通道已连接'), 'connected state renders')
assert.ok(text.includes('190600'), 'app id renders')
assert.ok(text.includes('保存配置'), 'save button renders')
assert.ok(text.includes('群人设'), 'group prompt renders')

function findForm(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'form') return node
  for (const child of node.children ?? []) {
    const hit = findForm(child)
    if (hit !== undefined) return hit
  }
  return undefined
}

const form = findForm(tree)
assert.ok(form !== undefined, 'the settings form is rendered')
await TestRenderer.act(async () => {
  form.props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setTimeout(resolve, 0))
})
const posted = calls.find(call => call.url === '/qgent/config' && call.options?.method === 'POST')
assert.ok(posted !== undefined, 'save posts the config')
const body = JSON.parse(posted.options.body)
assert.equal(body.mode, 'steer')
assert.equal(body.requireMention, false)
assert.equal(body.groupPrompt, '群人设')
assert.ok(!('appId' in body), 'credentials are not part of the config POST')

await TestRenderer.act(async () => {
  renderer.unmount()
})
console.log('client smoke: ok')
