/**
 * Smoke tests for dsh-qgent's pure helpers and plugin mount.
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  apply,
  chunkMarkdownText,
  isSilenceReply,
  normalizeConfig,
  resolveCredentials,
  upsertPatchRow,
} from '../index.js'

/** A Cordis-shaped context that records what the plugin registered. */
function mockContext() {
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const services = new Map()
  const warnings = []
  const ctx = {
    logger: {
      info() {},
      warn(message) { warnings.push(String(message)) },
      error() {},
      debug() {},
    },
    agents: {
      get() { return undefined },
      async resume() { throw new Error('not used') },
      async create() { throw new Error('not used') },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {}
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    inject() {},
  }
  return { ctx, tools, listeners, effects, services, warnings }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('normalizeConfig fills defaults and coerces bad input', () => {
  const config = normalizeConfig({ mode: 'bogus', textChunkLimit: 10, access: { c2cMode: 'nope' } })
  assert.equal(config.mode, 'steer')
  assert.equal(config.textChunkLimit, 4500)
  assert.equal(config.access.c2cMode, 'open')
  assert.equal(config.fallbackReply, true)
  assert.deepEqual(config.access.c2cAllow, [])
})

test('chunkMarkdownText splits at line boundaries and keeps fences intact', () => {
  const text = ['## title', 'a'.repeat(40), '```js', 'const x = 1', 'const y = 2', '```', 'tail'].join('\n')
  const chunks = chunkMarkdownText(text, 60)
  assert.ok(chunks.length > 1)
  const code = chunks.find(chunk => chunk.includes('const x = 1'))
  assert.ok(code !== undefined && code.includes('const y = 2'))
  assert.deepEqual(chunkMarkdownText('short', 60), ['short'])
})

test('isSilenceReply recognises the quiet markers', () => {
  assert.equal(isSilenceReply('NO_REPLY'), true)
  assert.equal(isSilenceReply('  [NO_REPLY] '), true)
  assert.equal(isSilenceReply('NO_REPLY, 我在'), false)
  assert.equal(isSilenceReply(''), false)
})

test('resolveCredentials inherits a bound im-qqbot row', () => {
  const previous = process.env.DSH_PROFILE_DIR
  const directory = mkdtempSync(join(process.cwd(), '.tmp-smoke-'))
  try {
    writeFileSync(join(directory, 'cordis.patch.yml'), [
      '- id: other',
      '  config: {}',
      '- id: im-qqbot',
      '  config:',
      "    appId: '123456'",
      '    appSecret: secret-value',
      '    requireMention: false',
      '',
    ].join('\n'))
    process.env.DSH_PROFILE_DIR = directory
    const credentials = resolveCredentials(normalizeConfig({}))
    assert.equal(credentials.appId, '123456')
    assert.equal(credentials.appSecret, 'secret-value')
    assert.ok(credentials.source.endsWith('cordis.patch.yml'))
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('apply registers the three QQ tools and both listeners without credentials', async () => {
  const previousProfile = process.env.DSH_PROFILE_DIR
  const previousId = process.env.QQBOT_APPID
  const previousSecret = process.env.QQBOT_SECRET
  delete process.env.DSH_PROFILE_DIR
  delete process.env.QQBOT_APPID
  delete process.env.QQBOT_SECRET
  try {
    const { ctx, tools, listeners, effects, warnings } = mockContext()
    apply(ctx, { inheritQQBot: false })
    assert.deepEqual([...tools.keys()].sort(), ['qq_chats', 'qq_send', 'qq_send_file'])
    assert.ok(listeners.has('system-prompt/assemble'))
    assert.ok(listeners.has('session/event'))
    assert.ok(effects.length >= 1)
    assert.ok(warnings.some(message => message.includes('no QQ credentials')))
    assert.equal(typeof tools.get('qq_send').execute, 'function')
    for (const dispose of effects) await dispose?.()
  } finally {
    if (previousProfile !== undefined) process.env.DSH_PROFILE_DIR = previousProfile
    if (previousId !== undefined) process.env.QQBOT_APPID = previousId
    if (previousSecret !== undefined) process.env.QQBOT_SECRET = previousSecret
  }
})

test('qq_send refuses an unknown chat and an empty body', async () => {
  const { ctx, tools } = mockContext()
  apply(ctx, { inheritQQBot: false })
  const send = tools.get('qq_send')
  await assert.rejects(() => send.execute({ text: 'hi' }, { agent: { id: 'nope' } }), /not bound to a QQ chat/)
  await assert.rejects(() => send.execute({ text: '' }, { agent: { id: 'nope' } }), /non-empty text/)
  const chats = tools.get('qq_chats')
  const result = await chats.execute({}, { agent: { id: 'nope' } })
  assert.equal(result.connected, false)
  assert.deepEqual(result.chats, [])
})

test('upsertPatchRow replaces one row without touching the others', () => {
  const original = [
    '- id: keep-me',
    '  config:',
    '    enabled: true',
    '- id: qgent',
    '  config:',
    '    debug: true',
    '- id: keep-me-too',
    '  disabled: true',
    '',
  ].join('\n')
  const next = upsertPatchRow(original, 'qgent', { requireMention: true, groupPrompt: 'line one\nline two' })
  assert.ok(next.includes('- id: keep-me'))
  assert.ok(next.includes('- id: keep-me-too'))
  assert.ok(next.includes('- id: qgent'))
  assert.ok(next.includes('requireMention: true'))
  assert.ok(next.includes('groupPrompt: |'))
  assert.ok(next.includes('    line two'))
  assert.ok(!next.includes('debug: true'))
  const appended = upsertPatchRow('- id: other\n  config: {}\n', 'qgent', { mode: 'queue' })
  assert.ok(appended.startsWith('- id: other'))
  assert.ok(appended.includes('mode: "queue"'))
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
