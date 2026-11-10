/**
 * dsh-qgent — put QQ on the other side of an agent's tool calls.
 *
 * The difference from a classic "IM channel" plugin is deliberate:
 *
 *   1. **Replies are tools.** An assistant message is not forwarded anywhere.
 *      `qq_send` / `qq_send_file` are the only things that reach QQ, so the
 *      model can say "查到了，在整理" mid-work, send a file when it exists,
 *      and stay silent when silence is the right answer.
 *   2. **Incoming messages have a delivery mode.** `steer` inserts the new
 *      message at the next step of the running turn (the agent reads it while
 *      it works); `queue` waits for the current turn to finish. Both are the
 *      host's own inbox semantics, not a second agent loop.
 *   3. **One QQ conversation is one session.** The mapping is deterministic
 *      (`qgent:<appId>:<scope>:<peerId>` → UUID-shaped session id), so a
 *      restart resumes the same conversation.
 *
 * The plugin owns the QQ connection (`@tencent-connect/qqbot-nodejs`), the
 * session map, the chat registry (so `qq_send` can address a chat it has seen),
 * and a small safety net: when a turn ends without a single `qq_send`, the
 * final assistant text is delivered once instead of being silently dropped.
 *
 * @module dsh-qgent
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Plugin identity used by loader diagnostics. */
export const name = 'qgent'

/** Hard dependencies: the agent registry and the tool registry. */
export const inject = ['agents', 'tools']

/** Package directory, used to find a locally installed QQ SDK. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Per-profile state lives beside the other plugins' state. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'qgent')
const MEDIA_DIR = join(STATE_DIR, 'media')
/** Per-chat generation counters: `/new` bumps the number, which changes the session id. */
const CHAT_STATE_FILE = join(STATE_DIR, 'chats.json')

/** Package version, shown by `/version`. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** `/help` body. */
const HELP_TEXT = [
  '**qgent 指令**',
  '',
  '`/new`（`/reset` `/clear`）· 开新会话，旧记录留档',
  '`/stop` · 打断当前回合',
  '`/status` · 连接、会话、模型、preset、消息数',
  '`/model [provider/model]` · 查看/切换模型（fork 保留上下文）',
  '`/preset [id]` · 查看/选择 preset（下一条 `/new` 生效）',
  '`/compact` · 压缩当前会话历史',
  '`/ping` · pong',
  '`/version` · 版本',
  '`/help` · 这条',
].join('\n')

/** QQ passive replies are limited per inbound message; beyond this we push. */
const PASSIVE_REPLY_LIMIT = 4
/** A passive reply window this old is treated as expired. */
const PASSIVE_REPLY_TTL_MS = 60 * 60 * 1000
/** How many inbound message ids one chat keeps as passive-reply candidates. */
const RECENT_MESSAGE_IDS = 6
/** Attachment download timeout. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** Delivery modes accepted by the host's prompt API. */
const DELIVERY_MODES = ['steer', 'queue']

/** Config defaults. The patch row only needs the values worth editing. */
const DEFAULTS = {
  appId: '',
  appSecret: '',
  inheritQQBot: true,
  requireMention: false,
  mode: 'steer',
  fallbackReply: true,
  markdown: true,
  textChunkLimit: 4500,
  sessionIdleTimeout: 30 * 60 * 1000,
  historyLimit: 10,
  cwd: '',
  preset: '',
  provider: '',
  model: '',
  groupPrompt: '',
  directPrompt: '',
  debug: false,
  access: {
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  },
  media: {
    enabled: true,
    maxMB: 200,
  },
  sendFile: {
    restrictPaths: true,
    extraRoots: [],
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Small coercion helpers
// ────────────────────────────────────────────────────────────────────────────

/** Return a trimmed string, or the fallback. */
function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Coerce one boolean-ish value, keeping the fallback when absent. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce one non-negative integer, keeping the fallback when unusable. */
function count(value, fallback, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded >= min ? rounded : fallback
}

/** Coerce one member of a fixed vocabulary. */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** Keep only plausible strings, de-duplicated. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const item = typeof entry === 'string' ? entry.trim() : ''
    if (item !== '' && !out.includes(item)) out.push(item)
  }
  return out
}

/** First N characters of an openid, for labels that must stay short. */
function shortId(id) {
  return typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id ?? '')
}

/** Format one byte count. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize the patch row into the shape the rest of the plugin expects.
 * @param raw - whatever the Loader passed as `config` (may be undefined).
 * @returns the effective configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const access = input.access !== null && typeof input.access === 'object' ? input.access : {}
  const media = input.media !== null && typeof input.media === 'object' ? input.media : {}
  const sendFile = input.sendFile !== null && typeof input.sendFile === 'object' ? input.sendFile : {}
  return {
    appId: str(input.appId),
    appSecret: str(input.appSecret),
    inheritQQBot: bool(input.inheritQQBot, DEFAULTS.inheritQQBot),
    requireMention: bool(input.requireMention, DEFAULTS.requireMention),
    mode: oneOf(input.mode, DELIVERY_MODES, DEFAULTS.mode),
    fallbackReply: bool(input.fallbackReply, DEFAULTS.fallbackReply),
    markdown: bool(input.markdown, DEFAULTS.markdown),
    textChunkLimit: count(input.textChunkLimit, DEFAULTS.textChunkLimit, 200),
    sessionIdleTimeout: count(input.sessionIdleTimeout, DEFAULTS.sessionIdleTimeout, 60_000),
    historyLimit: count(input.historyLimit, DEFAULTS.historyLimit, 0),
    cwd: str(input.cwd),
    preset: str(input.preset),
    provider: str(input.provider),
    model: str(input.model),
    groupPrompt: str(input.groupPrompt),
    directPrompt: str(input.directPrompt),
    debug: bool(input.debug, DEFAULTS.debug),
    access: {
      c2cMode: oneOf(access.c2cMode, ['open', 'allowlist', 'disabled'], 'open'),
      c2cAllow: stringList(access.c2cAllow),
      groupMode: oneOf(access.groupMode, ['open', 'allowlist', 'disabled'], 'open'),
      groupAllow: stringList(access.groupAllow),
    },
    media: {
      enabled: bool(media.enabled, DEFAULTS.media.enabled),
      maxMB: count(media.maxMB, DEFAULTS.media.maxMB, 1),
    },
    sendFile: {
      restrictPaths: bool(sendFile.restrictPaths, DEFAULTS.sendFile.restrictPaths),
      extraRoots: stringList(sendFile.extraRoots),
    },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Text: chunking and silence
// ────────────────────────────────────────────────────────────────────────────

const CODE_FENCE = /^```/
const TABLE_LINE = /^\|.+\|$/
const SILENCE_MARKERS = new Set(['NO_REPLY', 'NO REPLY', '[NO_REPLY]', '（不回复）', '(不回复)'])

/**
 * Split text at line boundaries under `limit`, keeping code fences and GFM
 * tables intact. Adapted from dsh-qqbot (MIT) so long answers still arrive.
 * @param text - the message to split.
 * @param limit - maximum characters per chunk.
 * @returns one or more chunks.
 */
export function chunkMarkdownText(text, limit) {
  if (typeof text !== 'string' || text === '') return []
  if (text.length <= limit) return [text]
  const lines = text.split('\n')
  const chunks = []
  let current = ''
  let inCode = false
  let table = []
  const flushTable = () => {
    if (table.length === 0) return
    const block = table.join('\n')
    table = []
    if (current === '') {
      current = block
      return
    }
    if (`${current}\n${block}`.length > limit) {
      chunks.push(current)
      current = block
    } else {
      current = `${current}\n${block}`
    }
  }
  const append = line => {
    if (current === '') {
      current = line
      return
    }
    if (`${current}\n${line}`.length > limit) {
      chunks.push(current)
      current = line
    } else {
      current = `${current}\n${line}`
    }
  }
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      flushTable()
      inCode = !inCode
      append(line)
      continue
    }
    if (inCode) {
      append(line)
      continue
    }
    if (TABLE_LINE.test(line)) {
      table.push(line)
      continue
    }
    flushTable()
    append(line)
  }
  flushTable()
  if (current !== '') chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

/**
 * Whether a reply is the conventional "I have nothing to say" marker.
 * @param text - candidate text.
 * @returns true when the whole reply is a silence marker.
 */
export function isSilenceReply(text) {
  if (typeof text !== 'string') return false
  return SILENCE_MARKERS.has(text.trim())
}

/** Pull the text blocks out of one assistant message. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
}

// ────────────────────────────────────────────────────────────────────────────
// QQ SDK loading
// ────────────────────────────────────────────────────────────────────────────

let sdkPromise

/** Places a locally or profile-installed QQ SDK can live. */
function sdkCandidates() {
  const out = []
  if (process.env.DSH_PROFILE_DIR) out.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'))
  out.push(join(HERE, 'node_modules'))
  out.push(join(DSH_HOME, 'node_modules'))
  return out
}

/** Load the SDK once; the host loader may resolve the bare specifier for us. */
function loadQQSDK() {
  if (sdkPromise !== undefined) return sdkPromise
  sdkPromise = (async () => {
    const failures = []
    try {
      const mod = await import('@tencent-connect/qqbot-nodejs')
      if (typeof mod?.QQBot === 'function') return mod
      failures.push('bare specifier resolved without a QQBot export')
    } catch (error) {
      failures.push(`bare specifier: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const root of sdkCandidates()) {
      const entry = join(root, '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js')
      if (!existsSync(entry)) continue
      try {
        const mod = await import(pathToFileURL(entry).href)
        if (typeof mod?.QQBot === 'function') return mod
        failures.push(`${entry}: no QQBot export`)
      } catch (error) {
        failures.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`cannot load @tencent-connect/qqbot-nodejs (${failures.join('; ')}). Install it beside the plugin, or in the profile: pnpm add @tencent-connect/qqbot-nodejs`)
  })()
  return sdkPromise
}

// ────────────────────────────────────────────────────────────────────────────
// Credentials
// ────────────────────────────────────────────────────────────────────────────

/** Read `appId` / `appSecret` / prompts from a bound im-qqbot row in the profile patch. */
function inheritedQQBotCredentials() {
  const directory = profileDirectory()
  if (directory === undefined) return {}
  const file = join(directory, 'cordis.patch.yml')
  if (!existsSync(file)) return {}
  let lines
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return {}
  }
  let inside = false
  const values = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!inside) {
      if (/^-\s+id:\s*im-qqbot\s*$/.test(line)) inside = true
      continue
    }
    // A new top-level entry ends this row; nested indentation does not matter.
    if (/^-\s/.test(line)) break
    const block = /^(\s+)(appId|appSecret|groupPrompt|directPrompt):\s*[|>][-+]?\s*$/.exec(line)
    if (block !== null) {
      const indent = block[1].length
      const collected = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const next = lines[cursor]
        if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break
        collected.push(next)
        cursor += 1
      }
      values[block[2]] = collected.map(item => item.slice(Math.min(item.length, indent + 2))).join('\n').replace(/\s+$/, '')
      index = cursor - 1
      continue
    }
    const match = /^\s+(appId|appSecret|groupPrompt|directPrompt):\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      const value = match[2].replace(/^['"]|['"]$/g, '').trim()
      if (value !== '' && !value.startsWith('$') && !value.startsWith('__')) values[match[1]] = value
    }
  }
  return values.appId && values.appSecret
    ? { appId: values.appId, appSecret: values.appSecret, source: file, ...(values.groupPrompt ? { groupPrompt: values.groupPrompt } : {}), ...(values.directPrompt ? { directPrompt: values.directPrompt } : {}) }
    : { ...(values.groupPrompt ? { groupPrompt: values.groupPrompt } : {}), ...(values.directPrompt ? { directPrompt: values.directPrompt } : {}), source: file }
}

/**
 * Locate the profile that owns this plugin.
 *
 * The Desktop host does not reliably export DSH_PROFILE_DIR into the Host
 * process, and this package is a link, so walking up from its own path never
 * crosses a profile's node_modules. Asking each profile's package.json whether
 * it depends on `dsh-qgent` is unambiguous and works for both layouts.
 */
function profileDirectory() {
  const fromEnv = str(process.env.DSH_PROFILE_DIR)
  if (fromEnv !== '' && existsSync(join(fromEnv, 'cordis.patch.yml'))) return fromEnv
  const home = str(process.env.DSH_HOME) || join(homedir(), '.dsh')
  const root = join(home, 'profiles')
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return undefined
  }
  const wanted = str(process.env.DSH_PROFILE)
  const owned = names.filter(name => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'))
      return typeof pkg?.dependencies?.['dsh-qgent'] === 'string'
    } catch {
      return false
    }
  })
  if (wanted !== '' && owned.includes(wanted)) return join(root, wanted)
  if (owned.length === 1) return join(root, owned[0])
  if (wanted !== '' && names.includes(wanted)) return join(root, wanted)
  return owned[0] === undefined ? undefined : join(root, owned[0])
}

/**
 * Resolve credentials in priority order: config → env → bound im-qqbot row.
 * @returns `{ appId, appSecret, source }`, empty strings when nothing is bound.
 */
export function resolveCredentials(config) {
  let appId = config.appId
  let appSecret = config.appSecret
  let source = appId !== '' && appSecret !== '' ? 'config' : ''
  if (appId === '' || appSecret === '') {
    const envId = str(process.env.QQBOT_APPID)
    const envSecret = str(process.env.QQBOT_SECRET)
    if (envId !== '' && envSecret !== '') {
      appId = envId
      appSecret = envSecret
      source = 'env'
    }
  }
  if ((appId === '' || appSecret === '') && config.inheritQQBot) {
    const inherited = inheritedQQBotCredentials()
    if (inherited.appId && inherited.appSecret) {
      appId = inherited.appId
      appSecret = inherited.appSecret
      source = inherited.source
    }
  }
  return { appId, appSecret, source }
}

// ────────────────────────────────────────────────────────────────────────────
// Chat registry
// ────────────────────────────────────────────────────────────────────────────

/** `${scope}:${peerId}` — how a chat is named in tools and logs. */
function chatKey(scope, peerId) {
  return `${scope}:${peerId}`
}

/** Parse `c2c:<openid>` / `group:<openid>`; undefined when malformed. */
function parseChatId(value) {
  const match = /^(c2c|group):(.+)$/.exec(typeof value === 'string' ? value.trim() : '')
  return match === null ? undefined : { scope: match[1], peerId: match[2] }
}

/**
 * Every QQ chat this host has seen. The registry is what makes `qq_send` from a
 * non-QQ session possible: only chats that have talked to the bot are known, so
 * prompt-injected strangers cannot be used as an exfiltration address.
 */
class ChatRegistry {
  constructor() {
    this.entries = new Map()
  }

  /** Record one inbound message and the passive-reply window it opens. */
  touch({ scope, peerId, label, msgId }) {
    const id = chatKey(scope, peerId)
    let entry = this.entries.get(id)
    if (entry === undefined) {
      entry = { id, scope, peerId, label: label || shortId(peerId), msgIds: [], lastActive: 0, received: 0, sent: 0 }
      this.entries.set(id, entry)
    }
    if (label) entry.label = label
    entry.lastActive = Date.now()
    entry.received += 1
    if (typeof msgId === 'string' && msgId !== '') {
      entry.msgIds = entry.msgIds.filter(item => item.id !== msgId)
      entry.msgIds.unshift({ id: msgId, at: Date.now(), used: 0 })
      entry.msgIds = entry.msgIds.slice(0, RECENT_MESSAGE_IDS)
    }
    return entry
  }

  get(id) {
    return this.entries.get(id)
  }

  list() {
    return [...this.entries.values()].sort((left, right) => right.lastActive - left.lastActive)
  }

  /** The newest inbound id that still has passive-reply budget left. */
  passiveId(entry) {
    const now = Date.now()
    for (const item of entry.msgIds) {
      if (now - item.at > PASSIVE_REPLY_TTL_MS) continue
      if (item.used >= PASSIVE_REPLY_LIMIT) continue
      item.used += 1
      return item.id
    }
    return undefined
  }

  /** Resolve a chat id or a bare peer id to a known entry. */
  resolve(value) {
    const parsed = parseChatId(value)
    if (parsed !== undefined) {
      const entry = this.entries.get(chatKey(parsed.scope, parsed.peerId))
      if (entry !== undefined) return entry
      return undefined
    }
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw === '') return undefined
    for (const entry of this.entries.values()) {
      if (entry.peerId === raw) return entry
    }
    return undefined
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Inbound composition
// ────────────────────────────────────────────────────────────────────────────

/** Classify a QQ attachment content_type. */
function attachmentKind(contentType) {
  const value = typeof contentType === 'string' ? contentType : ''
  if (value === 'image' || value.startsWith('image/')) return 'image'
  if (value === 'video' || value.startsWith('video/')) return 'video'
  if (value === 'voice' || value.startsWith('audio/')) return 'voice'
  return 'file'
}

const PRIVATE_IPV4 = [
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xe0000000, 4],
]

/** True when an IPv4 address is private/reserved (SSRF guard for downloads). */
function isPrivateIPv4(address) {
  const value = address.split('.').reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0
  return PRIVATE_IPV4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (base & mask) >>> 0
  })
}

/** Download one QQ attachment into the media directory (HTTPS only). */
async function downloadOne(att, maxBytes, log) {
  const url = String(att.url ?? '')
  if (url === '') return undefined
  let parsed
  try {
    parsed = new URL(url.startsWith('//') ? `https:${url}` : url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  try {
    const addresses = await dns.resolve4(parsed.hostname).catch(() => [])
    if (addresses.some(isPrivateIPv4)) {
      log.warn?.(`qgent: blocked private address for attachment ${att.filename ?? ''}`)
      return undefined
    }
  } catch {
    return undefined
  }
  if (typeof att.size === 'number' && att.size > maxBytes) return undefined
  try {
    const response = await fetch(parsed.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error('attachment exceeds the size limit')
    mkdirSync(MEDIA_DIR, { recursive: true })
    const name = sanitizeFilename(att.filename ?? 'attachment')
    const extension = extname(name)
    const stem = basename(name, extension)
    const target = join(MEDIA_DIR, `${stem}_${Date.now()}_${randomBytes(3).toString('hex')}${extension}`)
    writeFileSync(target, buffer)
    return { path: target.split(sep).join('/'), bytes: buffer.length }
  } catch (error) {
    log.warn?.(`qgent: attachment download failed (${att.filename ?? ''}): ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Strip path separators and characters Windows cannot store. */
function sanitizeFilename(name) {
  const base = basename(String(name).replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  return base === '' ? 'attachment' : base.normalize('NFC')
}

/** Escape one literal for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the text the agent reads for one inbound QQ message.
 *
 * No envelope and no per-message reminder: the session's system prompt already
 * binds it to QQ and says `qq_send` is the only way out. What remains is the
 * message as a chat would show it — the sender's openid as the stable identity,
 * quoted text and downloaded attachments when present.
 */
/**
 * Remove the bot's own @mention from inbound text.
 *
 * Prefers the structured `is_you` mention (its openid), and when the payload
 * has no such flag but the gate says the bot was mentioned, drops the leading
 * marker — that is the one that triggered the reply.
 */
function stripSelfMention(text, message, mentioned) {
  const mention = Array.isArray(message?.mentions) ? message.mentions.find(item => item?.is_you === true) : undefined
  const selfId = mention?.user_openid ?? mention?.member_openid ?? mention?.id
  let value = String(text ?? '')
  if (typeof selfId === 'string' && selfId !== '') {
    value = value.replace(new RegExp(`<@!?${escapeRegExp(selfId)}>\\s*`, 'g'), '')
  } else if (mentioned === true) {
    value = value.replace(/^\s*<@!?[^>]{1,64}>\s*/, '')
  }
  return value
}

async function composeInbound({ message, state, scope, label, senderId, text, config, log }) {
  const lines = []
  const mentioned = state?.mention?.wasMentioned === true
  const quote = state?.quote
  if (quote !== undefined && typeof quote.text === 'string' && quote.text.trim() !== '') {
    lines.push('[引用]', quote.text.trim(), '[当前]')
  }
  // The bot's own mention marker is noise: `(@你)` already says the message was
  // addressed to it. Markers naming other people stay — they are identities.
  const body = stripSelfMention(text, message, mentioned).trim()
  const who = `<@${senderId}>`
  if (body !== '') {
    // Groups carry the sender's stable openid in the platform's own mention
    // syntax: nicknames change, this does not.
    lines.push(scope === 'group' ? `${who} ${label}${mentioned ? ' (@你)' : ''}: ${body}` : body)
  } else if (mentioned) {
    lines.push(`${who} ${label} (@你)`)
  }
  const history = Array.isArray(state?.history) ? state.history : []
  const previous = history.filter(item => item?.messageId !== message.messageId)
  // Only mention-gated groups lose messages before they reach the session; when
  // every group message becomes a turn, the session log already holds this
  // history and repeating it here would duplicate the conversation.
  if (scope === 'group' && config.requireMention && config.historyLimit > 0 && previous.length > 0) {
    const recent = previous.slice(-config.historyLimit)
    lines.push('', '[群里最近]')
    for (const item of recent) {
      const name = item.senderName ?? shortId(item.senderId)
      lines.push(`<@${item.senderId}> ${name}: ${String(item.content ?? '').trim()}`)
    }
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  const voices = attachments.filter(item => attachmentKind(item.content_type) === 'voice')
  const media = []
  if (config.media.enabled) {
    const maxBytes = config.media.maxMB * 1024 * 1024
    for (const item of attachments) {
      if (attachmentKind(item.content_type) === 'voice') continue
      const downloaded = await downloadOne(item, maxBytes, log)
      if (downloaded !== undefined) media.push({ kind: attachmentKind(item.content_type), ...downloaded })
    }
  }
  if (media.length > 0) {
    lines.push('', '[对方发来的文件]')
    for (const item of media) lines.push(`- ${item.kind}: ${item.path} (${formatBytes(item.bytes)})`)
  }
  for (const voice of voices) {
    const asr = typeof voice.asr_refer_text === 'string' ? voice.asr_refer_text.trim() : ''
    if (asr !== '') lines.push(`[语音] ${asr}`)
  }
  return lines.length === 0 ? '' : lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────────────────────

/** Deterministic UUID-shaped session id for one QQ chat. */
function deriveSessionId(key) {
  const hash = createHash('sha256').update(key).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

/**
 * Durable per-chat state.
 *
 * - `gens`: `/new` bumps the generation, which changes the derived session id.
 * - `sessions`: a session id created by fork (model switch), overriding the
 *   derived one until the next `/new`.
 * - `models` / `presets`: per-chat overrides (`provider/model`, preset id).
 *
 * The previous session's log is never deleted; only the binding moves.
 */
class ChatState {
  constructor(file) {
    this.file = file
    this.data = { gens: {}, sessions: {}, models: {}, presets: {} }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        for (const bucket of ['gens', 'sessions', 'models', 'presets']) {
          if (parsed[bucket] !== null && typeof parsed[bucket] === 'object') this.data[bucket] = parsed[bucket]
        }
      }
    } catch {}
  }

  get(bucket, chatId) {
    const value = this.data[bucket][chatId]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  set(bucket, chatId, value) {
    if (typeof value === 'string' && value !== '') this.data[bucket][chatId] = value
    else delete this.data[bucket][chatId]
    this.save()
  }

  gen(chatId) {
    const value = Number(this.data.gens[chatId])
    return Number.isInteger(value) && value >= 0 ? value : 0
  }

  /** Next generation; forgets the forked session id so the derived id takes over. */
  bump(chatId) {
    this.data.gens[chatId] = this.gen(chatId) + 1
    delete this.data.sessions[chatId]
    this.save()
    return this.data.gens[chatId]
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
    } catch {
      // Losing the file only means a restart falls back to the previous binding.
    }
  }
}

/**
 * Map one QQ chat to one host session and deliver prompts into it.
 *
 * Creation mirrors what a channel plugin has to do: resume the persisted
 * session when it exists, otherwise create it with the configured cwd/preset/
 * model. Delivery goes through `sessionController.prompt`, whose `mode` is the
 * host's own steering/queueing contract.
 */
class QQSessionManager {
  constructor(ctx, config, log, chats) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.chats = chats
    this.sessions = new Map()
    this.pending = new Map()
    this.state = new ChatState(CHAT_STATE_FILE)
    const fallbackDirectory = this.ctx.get('workingDirectory')?.defaultDirectory
    this.cwd = config.cwd !== ''
      ? resolvePath(config.cwd)
      : (typeof fallbackDirectory === 'string' && fallbackDirectory !== '' ? fallbackDirectory : process.cwd())
    this.appLabel = 'qq'
  }

  setAppId(appId) {
    this.appLabel = appId === '' ? 'qq' : appId
  }

  key(scope, peerId) {
    const chatId = chatKey(scope, peerId)
    return `qgent:${this.appLabel}:${chatId}:${this.state.gen(chatId)}`
  }

  /** The live record currently bound to a chat, if any. */
  currentRecord(scope, peerId) {
    return this.sessions.get(this.key(scope, peerId))
  }

  /**
   * Attach a session to the registered workspace whose path is the agent cwd.
   *
   * `agents.create` gives a session a cwd but no workspace membership, which is
   * why the GUI lists it under 未分组. Attaching is what makes the workspace
   * list (and its permission rows) show it.
   */
  async attachWorkspace(sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.resolveByPath !== 'function') return
      const workspace = await registry.resolveByPath(this.cwd)
      if (workspace === undefined || typeof workspace.attachSession !== 'function') return
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return
      await workspace.attachSession(sessionId)
      this.log.info(`qgent: session ${shortId(sessionId)} attached to workspace ${workspace.id ?? workspace.path}`)
    } catch (error) {
      this.log.warn(`qgent: workspace attach failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * `/new`: dispose the bound agent and point the chat at a fresh generation.
   * The previous session's log is left on disk; nothing is deleted.
   */
  async rotate(scope, peerId) {
    const record = this.currentRecord(scope, peerId)
    if (record !== undefined) {
      this.sessions.delete(record.key)
      try {
        record.agent.cancel({ kind: 'user' })
      } catch {}
      await record.handle?.dispose?.().catch(() => {})
    }
    const generation = this.state.bump(chatKey(scope, peerId))
    this.log.info(`qgent: new session for ${chatKey(scope, peerId)} (generation ${generation})`)
    return generation
  }




  findByAgent(agent) {
    if (agent === undefined || agent === null) return undefined
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record
    }
    return undefined
  }

  bySessionId(sessionId) {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record
    }
    return undefined
  }

  list() {
    return [...this.sessions.values()]
  }

  /** Get or create the session bound to one QQ chat. */
  async ensure({ scope, peerId, senderId, label, replyTarget }) {
    const key = this.key(scope, peerId)
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      existing.replyTarget = replyTarget
      existing.label = label || existing.label
      existing.lastActivity = Date.now()
      return existing
    }
    const inFlight = this.pending.get(key)
    if (inFlight !== undefined) return inFlight
    const task = this.open({ key, scope, peerId, senderId, label, replyTarget }).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }

  async open({ key, scope, peerId, senderId, label, replyTarget }) {
    const agents = this.ctx.agents
    const chatId = chatKey(scope, peerId)
    // A forked session (model switch) overrides the derived id until `/new`.
    const sessionId = this.state.get('sessions', chatId) ?? deriveSessionId(key)
    const composed = await this.composePreset(scope, peerId)
    // A session without a model breaks prompt sections that read {{model}},
    // so always pin the configured or host-default route on create and resume.
    const route = this.resolveRoute(scope, peerId)
    let agent
    let handle
    const live = agents.get(sessionId)
    if (live !== undefined) {
      agent = live
      handle = undefined
    } else {
      try {
        const resumed = await agents.resume({
          resumeSessionId: sessionId,
          ...(route === undefined ? {} : { agentOptions: route }),
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        })
        agent = resumed.agent
        handle = resumed
        this.log.info(`qgent: resumed session ${sessionId} (${scope}/${shortId(peerId)})`)
      } catch (resumeError) {
        try {
          const created = await agents.create({
            sessionId,
            meta: {
              cwd: this.cwd,
              ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
            },
            ...(route === undefined ? {} : { agentOptions: route }),
            ...(composed.setup === undefined ? {} : { setup: composed.setup }),
          })
          agent = created.agent
          handle = created
          this.log.info(`qgent: created session ${sessionId} (${scope}/${shortId(peerId)})`)
        } catch (createError) {
          const detail = createError instanceof Error ? createError.message : String(createError)
          const earlier = resumeError instanceof Error ? resumeError.message : String(resumeError)
          throw new Error(`qgent: cannot open a session for ${scope}:${shortId(peerId)} (resume: ${earlier}; create: ${detail})`)
        }
      }
    }
    await this.attachWorkspace(sessionId)
    const record = {
      key,
      sessionId,
      scope,
      peerId,
      senderId,
      label: label || shortId(peerId),
      replyTarget,
      agent,
      handle,
      agentPreset: composed.agentPreset,
      cwd: this.cwd,
      lastActivity: Date.now(),
    }
    this.sessions.set(key, record)
    return record
  }

  async composePreset(scope, peerId) {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return {}
    const override = this.state.get('presets', chatKey(scope, peerId))
    const presetId = override ?? (this.config.preset === '' ? undefined : this.config.preset)
    try {
      const resolved = await presets.resolve(presetId)
      return {
        agentPreset: resolved.id,
        setup: async agentCtx => {
          await presets.mount(agentCtx, resolved.id)
        },
      }
    } catch (error) {
      this.log.warn(`qgent: preset ${presetId || '(default)'} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  /** The model route a new or resumed session runs on. */
  resolveRoute(scope, peerId) {
    const override = this.state.get('models', chatKey(scope, peerId))
    if (override !== undefined) {
      const slash = override.indexOf('/')
      if (slash > 0 && slash < override.length - 1) {
        return { provider: override.slice(0, slash), model: override.slice(slash + 1) }
      }
    }
    if (this.config.provider !== '' && this.config.model !== '') {
      return { provider: this.config.provider, model: this.config.model }
    }
    try {
      const service = this.ctx.get('agentDefaultModel')
      const selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {}
    return undefined
  }

  /**
   * Deliver one prompt into a QQ session.
   * @param record - the bound session.
   * @param text - already-composed message body.
   * @param mode - `steer` or `queue`.
   */
  async deliver(record, text, mode) {
    const controller = this.ctx.get('sessionController')
    if (controller !== undefined && typeof controller.prompt === 'function') {
      await controller.prompt({
        requestId: randomUUID(),
        sessionId: record.sessionId,
        mode,
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, AbortSignal.timeout(30_000))
      return
    }
    // Older compositions may lack the session controller; the agent inbox has
    // the same two operations, so fall back to it with a plain user message.
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    if (mode === 'steer') record.agent.steer(message)
    else record.agent.followup(message)
  }

  /** Fork the bound session onto another model, keeping the conversation. */
  async switchModel(scope, peerId, route) {
    const record = this.currentRecord(scope, peerId)
    if (record === undefined) throw new Error('这个聊天还没有活动会话，先随便发一条消息')
    const sessionsService = this.ctx.get('sessions')
    if (sessionsService === undefined || typeof sessionsService.fork !== 'function') {
      throw new Error('宿主没有 fork 能力，换不了模型')
    }
    let seed
    try {
      seed = sessionsService.fork(record.agent.session).events
    } catch (error) {
      throw new Error(`fork 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const composed = await this.composePreset(scope, peerId)
    const childId = randomUUID()
    const created = await this.ctx.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: record.cwd,
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
      },
      agentOptions: route,
      ...(composed.setup === undefined ? {} : { setup: composed.setup }),
    })
    const oldHandle = record.handle
    record.sessionId = childId
    record.agent = created.agent
    record.handle = created
    this.state.set('sessions', chatKey(scope, peerId), childId)
    this.state.set('models', chatKey(scope, peerId), `${route.provider}/${route.model}`)
    await this.attachWorkspace(childId)
    if (oldHandle !== undefined) Promise.resolve(oldHandle.dispose?.()).catch(() => {})
    this.log.info(`qgent: model switched for ${chatKey(scope, peerId)} → ${route.provider}/${route.model} (fork ${childId})`)
    return childId
  }

  /** Render the routable model catalog for `/model`. */
  async listModels(scope, peerId) {
    const current = this.resolveRoute(scope, peerId)
    const lines = [`当前模型：${current === undefined ? '宿主默认' : `${current.provider}/${current.model}`}`]
    const llm = this.ctx.get('llm')
    const entries = []
    try {
      const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
      for (const provider of providers) {
        const id = typeof provider === 'string' ? provider : provider?.id
        if (typeof id !== 'string' || id === '') continue
        const models = await llm.listModels(id)
        for (const model of models ?? []) {
          if (model?.id) entries.push(`${id}/${model.id}`)
        }
      }
    } catch {}
    if (entries.length === 0) {
      lines.push('这个部署拿不到模型目录，直接发 `/model provider/model` 指定。')
      return lines.join('\n')
    }
    const head = entries.slice(0, 20)
    lines.push('', ...head.map(entry => `- ${entry}`))
    if (entries.length > head.length) lines.push(`…共 ${entries.length} 个，用 \`/model provider/model\` 指定`)
    return lines.join('\n')
  }

  /** Render the preset catalog for `/preset`. */
  async listPresets() {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return '这个部署没有 preset 服务。'
    try {
      const list = await presets.list()
      return [
        '可用 preset：',
        ...list.map(item => `- ${item.id}${item.name ? ` · ${item.name}` : ''}`),
        '',
        '用 `/preset <id>` 选择，下一条 `/new` 生效',
      ].join('\n')
    } catch (error) {
      return `读取 preset 失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Persist a per-chat preset override (applies when the next session starts). */
  async setPreset(scope, peerId, presetId) {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) throw new Error('这个部署没有 preset 服务')
    const resolved = await presets.resolve(presetId)
    this.state.set('presets', chatKey(scope, peerId), resolved.id)
    return resolved.id
  }

  /** In-place compaction of the bound session. */
  async compact(scope, peerId) {
    const record = this.currentRecord(scope, peerId)
    if (record === undefined) return '当前没有活跃会话。'
    if (record.agent.status !== 'idle') return '正在生成中，等这轮结束再压缩。'
    let compaction
    try {
      const presets = this.ctx.get('agentPresets')
      compaction = presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')
    } catch {}
    if (compaction === undefined) return '这个会话的 preset 没挂 compaction 服务。'
    const route = this.resolveRoute(scope, peerId)
    try {
      const result = await compaction.compactNow({
        session: record.agent.session,
        options: route === undefined ? {} : { provider: route.provider, model: route.model },
        runMaintenance: record.agent.runMaintenance.bind(record.agent),
      }, AbortSignal.timeout(120_000))
      if (result === null) return '没有可压缩的历史。'
      return `✅ 已压缩 ${result.shadowedSeqs?.length ?? 0} 条历史（约 ${result.shadowedTokenCount ?? 0} tokens）`
    } catch (error) {
      return `压缩失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Count conversational events in one session (for `/status`). */
  messageCount(record) {
    const events = record?.agent?.session?.events
    if (!Array.isArray(events)) return 0
    let total = 0
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') total += 1
    }
    return total
  }

  /** Dispose sessions idle for longer than the configured timeout. */
  evictIdle() {
    const now = Date.now()
    for (const record of [...this.sessions.values()]) {
      if (now - record.lastActivity < this.config.sessionIdleTimeout) continue
      if (record.agent.status !== 'idle') continue
      this.sessions.delete(record.key)
      try {
        record.agent.cancel({ kind: 'user' })
      } catch {}
      void record.handle?.dispose?.().catch(() => {})
      this.log.debug(`qgent: evicted idle session ${record.sessionId}`)
    }
  }

  async disposeAll() {
    const records = [...this.sessions.values()]
    this.sessions.clear()
    for (const record of records) {
      try {
        record.agent.cancel({ kind: 'user' })
      } catch {}
    }
    await Promise.allSettled(records.map(record => record.handle?.dispose?.()))
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Turn tracking
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-session bookkeeping for the safety net: did this turn actually send
 * anything, and what was the last assistant text? The state resets on every
 * `turn/start`, so a stale `qq_send` from an earlier turn cannot silence the
 * fallback for a later one.
 */
class TurnTracker {
  constructor() {
    this.states = new Map()
  }

  state(sessionId) {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { turn: 0, sent: false, text: '' }
      this.states.set(sessionId, state)
    }
    return state
  }

  markSent(sessionId) {
    this.state(sessionId).sent = true
  }

  begin(sessionId, turn) {
    this.states.set(sessionId, { turn, sent: false, text: '' })
  }

  noteText(sessionId, text) {
    if (text === '') return
    this.state(sessionId).text = text
  }

  /** Drop the remembered text when a tool call or a new user message follows it. */
  clearText(sessionId) {
    const state = this.states.get(sessionId)
    if (state !== undefined) state.text = ''
  }

  end(sessionId) {
    const state = this.state(sessionId)
    this.states.delete(sessionId)
    return state
  }
}

// ────────────────────────────────────────────────────────────────────────────
// QQ channel
// ────────────────────────────────────────────────────────────────────────────

/**
 * The QQ side: one SDK bot, the middleware chain the SDK ships, the inbound
 * handler that turns messages into session prompts, and the outbound helpers
 * the tools use.
 */
class QQChannel {
  constructor(ctx, config, log, sessions, chats) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.sessions = sessions
    this.chats = chats
    this.sdk = undefined
    this.bot = undefined
    this.ready = false
    this.startError = ''
    this.credentialSource = ''
  }

  async start() {
    try {
      this.sdk = await loadQQSDK()
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error)
      this.log.error(`qgent: ${this.startError}`)
      return
    }
    const sdk = this.sdk
    const logger = {
      info: (...args) => this.log.debug?.(...args),
      warn: (...args) => this.log.warn?.(...args),
      error: (...args) => this.log.error?.(...args),
      debug: (...args) => this.log.debug?.(...args),
    }
    let bot
    try {
      bot = new sdk.QQBot({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        transport: 'websocket',
        baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
        logger,
      })
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error)
      this.log.error(`qgent: cannot construct the QQ bot: ${this.startError}`)
      return
    }
    this.bot = bot
    this.installMiddlewares(bot)
    bot.on('message', mCtx => {
      void this.onMessage(mCtx).catch(error => {
        this.log.error(`qgent: inbound failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    bot.on('error', error => {
      this.log.error(`qgent: bot error: ${error instanceof Error ? error.message : String(error)}`)
    })
    bot.on('ready', () => {
      this.ready = true
      this.log.info('qgent: QQ bot ready')
    })
    // A gateway RESUME (normal after a blip) only emits `resumed`, never `ready`;
    // treating it as connected keeps the status endpoint honest.
    bot.on('resumed', () => {
      this.ready = true
      this.log.info('qgent: QQ bot session resumed')
    })
    try {
      bot.on('disconnected', event => {
        const detail = `${event?.code ?? '?'}${event?.reason ? ` ${event.reason}` : ''}`
        if (event?.willReconnect === false) {
          this.ready = false
          this.log.error(`qgent: QQ bot disconnected for good (${detail})`)
        } else {
          // The SDK reconnects on its own; keep the flag and let `resumed` (or the
          // next inbound message) confirm liveness instead of flapping to offline.
          this.log.warn(`qgent: QQ bot disconnected (${detail}), reconnecting`)
        }
      })
    } catch {
      // Older SDKs do not know this event; nothing to observe there.
    }
    // `start()` resolves when the connection ends, so it must not block `apply`.
    void bot.start().catch(error => {
      this.ready = false
      this.startError = error instanceof Error ? error.message : String(error)
      this.log.error(`qgent: QQ bot failed to start: ${this.startError}`)
    })
    this.log.info(`qgent: connecting to QQ (appId=${this.config.appId})`)
  }

  installMiddlewares(bot) {
    const sdk = this.sdk
    bot.use(sdk.errorHandler({
      format: error => `⚠️ 处理消息时出错：${error instanceof Error ? error.message : String(error)}`,
    }))
    bot.use(sdk.messageFilter({ skipSelfEcho: false }))
    bot.use(sdk.accessPolicy({
      c2c: {
        mode: this.config.access.c2cMode,
        allow: this.config.access.c2cAllow.length > 0 ? this.config.access.c2cAllow : ['*'],
      },
      group: {
        mode: this.config.access.groupMode,
        allow: this.config.access.groupAllow.length > 0 ? this.config.access.groupAllow : ['*'],
      },
    }))
    bot.use(sdk.historyBuffer({ limit: this.config.historyLimit }))
    bot.use(sdk.mentionGate({ requireMentionInGroup: this.config.requireMention }))
    bot.use(sdk.contentSanitizer({ parseFaceTags: true, stripAllMentions: false }))
  }

  /** One inbound QQ message → one prompt delivered into its session. */
  async onMessage(mCtx) {
    // A message proves the gateway path is alive; self-heal the status flag.
    this.ready = true
    const message = mCtx.message
    const scope = message.kind === 'group' ? 'group' : message.kind === 'c2c' ? 'c2c' : undefined
    if (scope === undefined) return
    const peerId = scope === 'group' ? (message.groupOpenid ?? message.senderId) : message.senderId
    if (typeof peerId !== 'string' || peerId === '') return
    const senderId = message.senderId ?? peerId
    const senderLabel = message.senderName ?? shortId(senderId)
    // The chat label names the conversation (a group has no name in the event,
    // only its openid); the message header names the person who spoke.
    const chatLabel = scope === 'group' ? `群 ${shortId(peerId)}` : senderLabel
    // The event content still carries `<@bot-openid>` when someone @-mentions the
    // bot. Strip it before parsing, or `/ping` looks like ordinary text and goes
    // to the model instead of the command handler.
    const mentioned = mCtx.state?.mention?.wasMentioned === true
    const rawContent = stripSelfMention(message.content ?? '', message, mentioned)
    let parsed = parseModePrefix(rawContent, this.config.mode)
    const replyTarget = { scope, targetId: peerId, msgId: message.messageId }
    this.chats.touch({ scope, peerId, label: chatLabel, msgId: message.messageId })
    const entry = this.chats.get(chatKey(scope, peerId))
    // /new (alias /reset) rebinds the chat to a fresh session; /stop cancels the
    // running turn. Both are handled here, before the model ever sees the text.
    const command = /^\s*(?:<@[^>]{1,64}>\s*)*\/(new|reset|clear|stop|status|model|preset|compact|ping|version|help|bot-help)\b\s*([\s\S]*)$/i.exec(parsed.text)
    if (command !== null) {
      const outcome = await this.runCommand(command[1].toLowerCase(), command[2].trim(), scope, peerId, entry)
      if (outcome.handled) {
        if (outcome.text === undefined || outcome.text === '') return
        parsed = { text: outcome.text, mode: parsed.mode }
      }
    }
    const body = await composeInbound({
      message,
      state: mCtx.state,
      scope,
      label: senderLabel,
      senderId,
      text: parsed.text,
      config: this.config,
      log: this.log,
    })
    if (body === '') {
      this.log.debug(`qgent: ignored empty ${scope} message from ${shortId(senderId)}`)
      return
    }
    if (this.config.debug) this.log.debug(`qgent: inbound ${scope}/${shortId(peerId)} mode=${parsed.mode}: ${body.slice(0, 240)}`)
    let record
    try {
      record = await this.sessions.ensure({ scope, peerId, senderId, label: chatLabel, replyTarget })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`qgent: ${detail}`)
      const entry = this.chats.get(chatKey(scope, peerId))
      if (entry !== undefined) await this.sendText(entry, `⚠️ 建会话失败：${detail}`).catch(() => {})
      return
    }
    try {
      await this.sessions.deliver(record, body, parsed.mode)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`qgent: delivery failed: ${detail}`)
      const entry = this.chats.get(chatKey(scope, peerId))
      if (entry !== undefined) await this.sendText(entry, `⚠️ 消息没送进 agent：${detail}`).catch(() => {})
    }
  }

  /**
   * Slash commands, handled before a message ever reaches the model.
   * @returns `{ handled: true, text? }`; `text` is delivered into the session
   *   (only `/new` with trailing text does that).
   */
  async runCommand(word, rest, scope, peerId, entry) {
    const reply = text => this.sendText(entry, text)
    const record = this.sessions.currentRecord(scope, peerId)
    switch (word) {
      case 'new':
      case 'reset':
      case 'clear': {
        const generation = await this.sessions.rotate(scope, peerId)
        await reply(`🔄 新会话（第 ${generation + 1} 代）。旧记录还在磁盘上，只是不再参与。`)
        return { handled: true, text: rest }
      }
      case 'stop': {
        if (record === undefined) {
          await reply('现在没有在跑的回合。')
          return { handled: true }
        }
        try {
          record.agent.cancel({ kind: 'user' })
        } catch {}
        await reply('⏹ 已打断当前回合。')
        return { handled: true }
      }
      case 'status': {
        const route = this.sessions.resolveRoute(scope, peerId)
        const preset = record?.agentPreset ?? (this.config.preset !== '' ? this.config.preset : '默认')
        await reply([
          `QQ：${this.ready ? '已连接' : '未连接'}（appId ${this.config.appId}）`,
          `会话：${record === undefined ? '(还没建立)' : `${shortId(record.sessionId)} · ${record.agent.status}`}`,
          `模型：${route === undefined ? '宿主默认' : `${route.provider}/${route.model}`}`,
          `preset：${preset}`,
          `消息：${this.sessions.messageCount(record)} 条`,
          `投递：${this.config.mode}${this.config.fallbackReply ? ' · 兜底补发开' : ''}`,
        ].join('\n'))
        return { handled: true }
      }
      case 'model': {
        if (rest === '') {
          await reply(await this.sessions.listModels(scope, peerId))
          return { handled: true }
        }
        const fallback = this.sessions.resolveRoute(scope, peerId)
        let provider
        let model
        if (rest.includes('/')) {
          const slash = rest.indexOf('/')
          provider = rest.slice(0, slash)
          model = rest.slice(slash + 1)
        } else {
          provider = fallback?.provider
          model = rest
        }
        if (!provider || !model) {
          await reply('用法：`/model provider/model`')
          return { handled: true }
        }
        try {
          const childId = await this.sessions.switchModel(scope, peerId, { provider, model })
          await reply(`✅ 模型已换成 ${provider}/${model}，上下文 fork 保留（${shortId(childId)}）`)
        } catch (error) {
          await reply(`切换失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return { handled: true }
      }
      case 'preset': {
        if (rest === '') {
          await reply(await this.sessions.listPresets())
          return { handled: true }
        }
        try {
          const id = await this.sessions.setPreset(scope, peerId, rest)
          await reply(`✅ preset 记为 ${id}，下一条 /new 生效`)
        } catch (error) {
          await reply(`设置失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return { handled: true }
      }
      case 'compact': {
        await reply(await this.sessions.compact(scope, peerId))
        return { handled: true }
      }
      case 'ping': {
        await reply('pong 🏓')
        return { handled: true }
      }
      case 'version': {
        await reply(`qgent ${VERSION}`)
        return { handled: true }
      }
      case 'help':
      case 'bot-help': {
        await reply(HELP_TEXT)
        return { handled: true }
      }
      default:
        return { handled: false }
    }
  }

  /** Resolve the passive/proactive reply target for one chat. */
  replyTarget(entry) {
    const ids = Array.isArray(entry.msgIds) ? entry.msgIds : []
    const id = ids.length === 0 ? undefined : this.chats.passiveId(entry)
    return id === undefined
      ? { scope: entry.scope, targetId: entry.peerId }
      : { scope: entry.scope, targetId: entry.peerId, msgId: id }
  }

  /** Send one already-chunked text piece, preferring markdown. */
  async sendChunk(entry, text) {
    if (this.bot === undefined) throw new Error(this.startError || 'QQ 通道还没连上')
    const target = this.replyTarget(entry)
    if (this.config.markdown) {
      try {
        const sent = await this.bot.sendMarkdown(target, text)
        return sent
      } catch (error) {
        this.log.debug(`qgent: markdown send failed, retrying as text: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.bot.sendText(target, text)
  }

  /** Send text to one chat, chunked to the platform limit. */
  async sendText(entry, text) {
    const chunks = chunkMarkdownText(text, this.config.textChunkLimit)
    if (chunks.length === 0) throw new Error('nothing to send (empty text)')
    let last
    for (const chunk of chunks) {
      last = await this.sendChunk(entry, chunk)
    }
    entry.sent += 1
    return { chunks: chunks.length, messageId: last?.id }
  }

  /** Send a local file/image/video/voice to one chat. */
  async sendFile(entry, { path, caption = '', kind = 'auto' }) {
    if (this.bot === undefined) throw new Error(this.startError || 'QQ 通道还没连上')
    const target = this.replyTarget(entry)
    const detected = kind === 'auto' ? fileKind(path) : kind
    const source = { localPath: path }
    if (detected === 'image') return this.bot.sendImage(target, source, caption === '' ? undefined : { content: caption })
    if (detected === 'video') return this.bot.sendVideo(target, source, caption === '' ? undefined : { content: caption })
    if (detected === 'voice') return this.bot.sendVoice(target, source)
    return this.bot.sendFile(target, source, { fileName: basename(path), ...(caption === '' ? {} : { content: caption }) })
  }

  /** Chat entry for a bound session record (rebuilding it after a restart). */
  entryFor(record) {
    return this.chats.get(chatKey(record.scope, record.peerId))
      ?? this.chats.touch({ scope: record.scope, peerId: record.peerId, label: record.label })
  }

  stop() {
    try {
      this.bot?.stop()
    } catch {}
    this.bot = undefined
  }
}

/** Parse an optional `#queue` / `#steer` prefix from a human message. */
function parseModePrefix(content, fallback) {
  const text = typeof content === 'string' ? content : ''
  const match = /^\s*#(queue|steer)\b[:\s]*/i.exec(text)
  if (match === null) return { text: text.trim(), mode: fallback }
  return { text: text.slice(match[0].length).trim(), mode: match[1].toLowerCase() }
}

/** Decide the QQ media kind from a file extension. */
function fileKind(file) {
  const extension = extname(file).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico'].includes(extension)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'].includes(extension)) return 'video'
  if (['.silk', '.amr', '.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(extension)) return 'voice'
  return 'file'
}

/** Whether `child` stays inside `root` (no `..` escape). */
function isInside(root, child) {
  const rel = relative(resolvePath(root), resolvePath(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Resolve and gate a local file the model wants to send. */
function resolveSendablePath(raw, record, config) {
  const value = str(raw)
  if (value === '') throw new Error('qq_send_file needs a path')
  const base = record?.cwd ?? process.cwd()
  const absolute = isAbsolute(value) ? value : resolvePath(base, value)
  if (!existsSync(absolute)) throw new Error(`qq_send_file: no such file: ${absolute}`)
  const stat = statSync(absolute)
  if (!stat.isFile()) throw new Error(`qq_send_file: not a regular file: ${absolute}`)
  const real = realpathSync(absolute)
  if (config.sendFile.restrictPaths) {
    const roots = [record?.cwd ?? process.cwd(), MEDIA_DIR, ...config.sendFile.extraRoots]
    if (!roots.some(root => isInside(root, real))) {
      throw new Error(`qq_send_file: ${real} is outside the allowed roots (${roots.join(', ')}); add it to sendFile.extraRoots or set restrictPaths: false`)
    }
  }
  return real
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt text
// ────────────────────────────────────────────────────────────────────────────

/** The model-facing instructions injected into every qgent session. */
function channelPrompt(record, config) {
  const where = record.scope === 'group' ? `群聊「${record.label}」` : `私聊（${record.label || shortId(record.peerId)}）`
  const extra = record.scope === 'group' ? config.groupPrompt : config.directPrompt
  return [
    '## QQ 通道（qgent）',
    `这个会话绑定的 QQ ${where}。客户端的聊天 id 是 \`${chatKey(record.scope, record.peerId)}\`。`,
    '你在这里写的普通回答不会出现在 QQ 里。只有调用 `qq_send`（文字）或 `qq_send_file`（文件/图片）才会真正发到 QQ。',
    '收到 QQ 消息后，先判断要不要回；不回就结束，不用解释。要回就调用 qq_send。',
    '长任务进行中，随时用 qq_send 发一两句进度（例如「在查了」「快好了」），不要憋到最后才说话。',
    '一个回合里可以多次 qq_send：先发进度，继续干活，再发结果。也别发太碎，别刷屏。',
    'QQ 里说话要短、口语化：不要 Markdown 标题、表格、代码块，不贴工具输出、代码和内部路径。',
    '需要把文件或图片发给对方时用 `qq_send_file`；其他聊天可以用 `qq_chats` 查到 id 后带 `chat` 参数发送。',
    record.scope === 'group' ? '群里可能同时有别人说话；只回该你回的那条。' : '',
    extra,
  ].filter(Boolean).join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Settings-page compatibility (the dsh-qqbot client page, driven by qgent)
// ────────────────────────────────────────────────────────────────────────────

/** The config object the old qqbot settings page reads. */
function uiConfig(settings, credentials) {
  return {
    appId: settings.appId !== '' ? settings.appId : credentials.appId,
    provider: settings.provider,
    model: settings.model,
    preset: settings.preset,
    cwd: settings.cwd,
    requireMention: settings.requireMention,
    // The old page still renders these two switches; qgent has no equivalent.
    streaming: false,
    showToolResults: false,
    groupPrompt: settings.groupPrompt,
    directPrompt: settings.directPrompt,
    access: { ...settings.access },
    debug: settings.debug,
    textChunkLimit: settings.textChunkLimit,
    sessionIdleTimeout: settings.sessionIdleTimeout,
    historyLimit: settings.historyLimit,
    mode: settings.mode,
    fallbackReply: settings.fallbackReply,
    markdown: settings.markdown,
    media: { ...settings.media },
    sendFile: { ...settings.sendFile },
    inheritQQBot: settings.inheritQQBot,
  }
}

/** YAML scalar formatting for the small config subset we write. */
function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return JSON.stringify(String(value ?? ''))
}

/** Emit one mapping body (indent spaces, one key per line). */
function yamlMapping(object, indent, lines) {
  const pad = ' '.repeat(indent)
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`)
        continue
      }
      lines.push(`${pad}${key}:`)
      for (const item of value) lines.push(`${pad}  - ${yamlScalar(item)}`)
      continue
    }
    if (value !== null && typeof value === 'object') {
      lines.push(`${pad}${key}:`)
      yamlMapping(value, indent + 2, lines)
      continue
    }
    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${pad}${key}: |`)
      for (const line of value.split('\n')) lines.push(`${pad}  ${line}`)
      continue
    }
    lines.push(`${pad}${key}: ${yamlScalar(value)}`)
  }
}

/** Replace (or append) one top-level `- id: <rowId>` block, leaving the rest alone. */
export function upsertPatchRow(text, rowId, config) {
  const block = [`- id: ${rowId}`, '  config:']
  yamlMapping(config, 4, block)
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const matcher = new RegExp(`^-\\s+id:\\s*${rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  const start = lines.findIndex(line => matcher.test(line))
  if (start !== -1) {
    let end = start + 1
    while (end < lines.length && !/^-\s/.test(lines[end])) end += 1
    let stop = end
    while (stop > start && lines[stop - 1].trim() === '') stop -= 1
    return [...lines.slice(0, start), ...block, ...lines.slice(stop)].join('\n').replace(/\n*$/, '\n')
  }
  const base = text.replace(/\s*$/, '')
  return `${base === '' ? '' : `${base}\n`}${block.join('\n')}\n`
}

/** Persist one row's config into the profile patch (the loader hot-reloads it). */
function saveProfileConfig(rowId, config) {
  const directory = profileDirectory()
  if (directory === undefined) return { ok: false, error: 'cannot locate the DSH profile directory' }
  const file = join(directory, 'cordis.patch.yml')
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    writeFileSync(file, upsertPatchRow(current, rowId, config))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Everything qgent needs to restart from the same place (no read-only fields). */
function persistableConfig(settings, credentials, includeCredentials = false) {
  return {
    ...(includeCredentials ? { appId: credentials.appId, appSecret: credentials.appSecret, inheritQQBot: false } : {}),
    requireMention: settings.requireMention,
    mode: settings.mode,
    fallbackReply: settings.fallbackReply,
    markdown: settings.markdown,
    textChunkLimit: settings.textChunkLimit,
    sessionIdleTimeout: settings.sessionIdleTimeout,
    historyLimit: settings.historyLimit,
    cwd: settings.cwd,
    preset: settings.preset,
    provider: settings.provider,
    model: settings.model,
    groupPrompt: settings.groupPrompt,
    directPrompt: settings.directPrompt,
    access: { ...settings.access },
    media: { ...settings.media },
    sendFile: { ...settings.sendFile },
    debug: settings.debug,
  }
}

/** Validate the subset the old page may post. */
function sanitizeUiPatch(body) {
  const out = {}
  const fail = message => {
    throw new TypeError(message)
  }
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'streaming':
      case 'showToolResults':
        // Accepted for page compatibility; qgent does not auto-forward anything.
        break
      case 'requireMention':
      case 'debug':
      case 'fallbackReply':
      case 'markdown':
        if (typeof value !== 'boolean') fail(`${key} must be a boolean`)
        out[key] = value
        break
      case 'provider':
      case 'model':
      case 'preset':
      case 'groupPrompt':
      case 'directPrompt':
      case 'mode':
      case 'cwd':
        if (typeof value !== 'string') fail(`${key} must be a string`)
        if (value.length > 20000) fail(`${key} is too long`)
        out[key] = value
        break
      case 'access': {
        if (value === null || typeof value !== 'object') fail('access must be an object')
        const mode = candidate => (['open', 'allowlist', 'disabled'].includes(candidate) ? candidate : 'open')
        const list = candidate => (Array.isArray(candidate) ? candidate.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [])
        out.access = {
          c2cMode: mode(value.c2cMode),
          c2cAllow: list(value.c2cAllow),
          groupMode: mode(value.groupMode),
          groupAllow: list(value.groupAllow),
        }
        break
      }
      default:
        if (key === 'appId' || key === 'appSecret') fail('use the binding controls to change credentials')
        fail(`unsupported field: ${key}`)
    }
  }
  return out
}

/** JSON response helper. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/** Minimal same-origin check, matching the old page's expectations. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Read a small JSON request body. */
async function readJsonBody(req, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('empty request body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Serve the settings panel that ships with this package (`client.js`).
 *
 * The panel is a `settings.section` registration; every value it shows comes
 * from these routes. Saving writes qgent's row into the profile patch, which
 * the Loader hot-reloads with the new configuration.
 */
function installSettingsRoutes(ctx, { settings, credentials, log, channel }) {
  const rowId = 'qgent'

  // Settings endpoints for the panel that ships with this package.
  const routes = [
    {
      kind: 'exact',
      path: '/qgent/status',
      handler: (req, res) => {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        let clientPath = null
        try {
          const modules = ctx.get('clientModules')
          clientPath = typeof modules?.clientPath === 'function' ? (modules.clientPath('dsh-qgent') ?? null) : 'no-service'
        } catch (error) {
          clientPath = `error: ${error instanceof Error ? error.message : String(error)}`
        }
        sendJson(res, 200, {
          connected: channel.ready,
          appId: settings.appId !== '' ? settings.appId : credentials.appId,
          error: channel.startError,
          profile: profileDirectory() ?? '',
          clientPath,
        })
      },
    },
    {
      kind: 'exact',
      path: '/qgent/config',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
        if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, { config: uiConfig(settings, credentials) })
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: `invalid request body: ${error instanceof Error ? error.message : String(error)}` })
        }
        if (body === null || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        let patch
        try {
          patch = sanitizeUiPatch(body)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        const next = { ...settings, ...patch }
        next.access = patch.access === undefined ? settings.access : { ...settings.access, ...patch.access }
        const saved = saveProfileConfig(rowId, persistableConfig(next, credentials))
        if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error })
        log.info(`qgent: config updated from the settings page (${saved.file})`)
        sendJson(res, 200, { ok: true, message: '配置已保存，qgent 将自动重载' })
      },
    },
    {
      kind: 'exact',
      path: '/qgent/bind',
      handler: async (req, res) => {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req, 4096)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: `invalid request body: ${error instanceof Error ? error.message : String(error)}` })
        }
        const appId = str(body?.appId)
        const appSecret = str(body?.appSecret)
        if (appId === '' || appSecret === '') return sendJson(res, 400, { ok: false, error: 'appId 与 appSecret 不能为空' })
        if (appId.length > 128 || appSecret.length > 256) return sendJson(res, 400, { ok: false, error: '凭据长度不合法' })
        const saved = saveProfileConfig(rowId, persistableConfig(settings, { appId, appSecret }, true))
        if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error })
        log.info(`qgent: credentials updated from the settings page (${saved.file})`)
        sendJson(res, 200, { ok: true, message: '凭据已保存，qgent 将自动重载' })
      },
    },
    {
      kind: 'exact',
      path: '/qgent/unbind',
      handler: (req, res) => {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' })
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        req.resume()
        if (settings.appId === '' && credentials.source === 'env') {
          return sendJson(res, 409, { ok: false, error: '凭据来自环境变量，无法在页面解绑' })
        }
        const saved = saveProfileConfig(rowId, { ...persistableConfig(settings, credentials), appId: '', appSecret: '', inheritQQBot: false })
        if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error })
        log.info(`qgent: credentials cleared from the settings page (${saved.file})`)
        sendJson(res, 200, { ok: true, message: '已解绑，qgent 将重载并保持离线' })
      },
    },
  ]
  // `inject` (rather than a one-shot get) keeps the panel working when the Web
  // carrier mounts after this plugin, and re-registers after every reload —
  // a missing carrier at apply time used to leave the page with a 404.
  ctx.inject(['webServer'], scoped => {
    const webServer = scoped.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return
    for (const route of routes) {
      scoped.effect(() => {
        try {
          return webServer.register(route)
        } catch (error) {
          log.warn(`qgent: cannot register ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
          return () => {}
        }
      })
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Plugin
// ────────────────────────────────────────────────────────────────────────────

/** Register one tool for the lifetime of the plugin. */
function registerTool(ctx, log, definition) {
  try {
    ctx.effect(() => ctx.tools.register(definition))
  } catch (error) {
    log.warn?.(`qgent: could not register ${definition.name} (${String(error)})`)
  }
}

/**
 * Mount the plugin.
 * @param ctx - the host context.
 * @param config - the patch row's configuration.
 */
export function apply(ctx, config) {
  const log = ctx.logger ?? console
  const settings = normalizeConfig(config)
  // Migration aid: while inheritQQBot is on, keep the persona prompts the user
  // already wrote for dsh-qqbot instead of starting from an empty page.
  if (settings.inheritQQBot && (settings.groupPrompt === '' || settings.directPrompt === '')) {
    const inherited = inheritedQQBotCredentials()
    if (settings.groupPrompt === '' && typeof inherited.groupPrompt === 'string') settings.groupPrompt = inherited.groupPrompt
    if (settings.directPrompt === '' && typeof inherited.directPrompt === 'string') settings.directPrompt = inherited.directPrompt
  }
  const chats = new ChatRegistry()
  const sessions = new QQSessionManager(ctx, settings, log, chats)
  const channel = new QQChannel(ctx, settings, log, sessions, chats)
  const tracker = new TurnTracker()

  /** The QQ binding of one agent, when it has one. */
  const recordOf = agent => sessions.findByAgent(agent) ?? sessions.bySessionId(agent?.id)

  /** Resolve the chat a tool should write to. */
  const chatFor = (requested, record) => {
    const value = str(requested)
    if (value !== '') {
      const entry = chats.resolve(value)
      if (entry === undefined) {
        const known = chats.list().map(item => item.id).join(', ') || '(none yet)'
        throw new Error(`qgent: unknown chat "${value}". Known chats: ${known}`)
      }
      return entry
    }
    if (record === undefined) {
      throw new Error('qgent: this session is not bound to a QQ chat; pass `chat` (see `qq_chats`)')
    }
    const entry = chats.get(chatKey(record.scope, record.peerId))
    if (entry === undefined) {
      // A restored session can outlive the in-memory registry; rebuild the entry.
      return chats.touch({ scope: record.scope, peerId: record.peerId, label: record.label })
    }
    return entry
  }

  registerTool(ctx, log, {
    name: 'qq_send',
    description: 'Send a message to QQ. This is the only way words reach the QQ chat bound to this session (or another known chat, with `chat`). Call it as often as the conversation needs — progress in the middle of a long task, a short answer, a follow-up — and call it never when silence is right. Text is split automatically at the platform limit.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message body. Keep it short and conversational; QQ has no markdown tables/headings worth using.' },
        chat: { type: 'string', description: 'Optional target: "c2c:<openid>" or "group:<openid>" as listed by qq_chats. Defaults to this session\'s bound chat.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean' },
          chat: { type: 'string' },
          chunks: { type: 'number' },
        },
        required: ['sent', 'chat', 'chunks'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Sent${value.chunks > 1 ? ` ${value.chunks} chunks` : ''} to ${value.chat}.`,
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = str(args?.text)
      if (text === '') throw new Error('qq_send needs non-empty text')
      const record = recordOf(exec.agent)
      const entry = chatFor(args?.chat, record)
      const result = await channel.sendText(entry, text)
      if (record !== undefined) tracker.markSent(record.sessionId)
      return { sent: true, chat: entry.id, chunks: result.chunks }
    },
  })

  registerTool(ctx, log, {
    name: 'qq_send_file',
    description: 'Send a local file, image, video or voice message to QQ. The path may be relative to this session\'s working directory. Use it when the deliverable is a file rather than text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local path of the file to send (relative paths resolve against the session cwd).' },
        caption: { type: 'string', description: 'Optional text that accompanies the file.' },
        chat: { type: 'string', description: 'Optional target: "c2c:<openid>" or "group:<openid>". Defaults to this session\'s bound chat.' },
        kind: { type: 'string', enum: ['auto', 'image', 'video', 'voice', 'file'], description: 'Force one QQ media kind instead of detecting it from the extension.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sent: { type: 'boolean' },
          chat: { type: 'string' },
          file: { type: 'string' },
        },
        required: ['sent', 'chat', 'file'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Sent ${value.file} to ${value.chat}.` }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = recordOf(exec.agent)
      const entry = chatFor(args?.chat, record)
      const file = resolveSendablePath(args?.path, record, settings)
      const kind = oneOf(args?.kind, ['auto', 'image', 'video', 'voice', 'file'], 'auto')
      await channel.sendFile(entry, { path: file, caption: str(args?.caption), kind })
      if (record !== undefined) tracker.markSent(record.sessionId)
      return { sent: true, chat: entry.id, file }
    },
  })

  registerTool(ctx, log, {
    name: 'qq_chats',
    description: 'List the QQ chats this host has seen: their ids (usable as `chat` in qq_send / qq_send_file), scope, label, and when they last spoke. Also reports whether the QQ connection is up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          error: { type: 'string' },
          build: { type: 'string' },
          profile: { type: 'string' },
          credentials: { type: 'string' },
          chats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chat: { type: 'string' },
                scope: { type: 'string' },
                label: { type: 'string' },
                bound: { type: 'boolean' },
                received: { type: 'number' },
                minutes_ago: { type: 'number' },
              },
              required: ['chat', 'scope', 'label', 'bound', 'received'],
              additionalProperties: false,
            },
          },
        },
        required: ['connected', 'chats'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [`QQ connection: ${value.connected ? 'up' : `down${value.error === undefined ? '' : ` (${value.error})`}`}`]
        if (value.build !== undefined) lines.push(`build ${value.build} · profile ${value.profile ?? '?'} · credentials ${value.credentials ?? '?'}`)
        if (value.chats.length === 0) lines.push('No QQ chat has talked to this host yet.')
        for (const chat of value.chats) {
          const when = chat.minutes_ago === undefined ? '' : ` · ${chat.minutes_ago}m ago`
          lines.push(`- ${chat.chat} ${chat.label}${chat.bound ? ' (this session)' : ''}${when}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const current = recordOf(exec.agent)
      const now = Date.now()
      const list = chats.list().map(entry => ({
        chat: entry.id,
        scope: entry.scope,
        label: entry.label,
        bound: current !== undefined && entry.id === chatKey(current.scope, current.peerId),
        received: entry.received,
        minutes_ago: Math.max(0, Math.floor((now - entry.lastActive) / 60_000)),
      }))
      return {
        connected: channel.ready && channel.bot !== undefined,
        ...(channel.startError === '' ? {} : { error: channel.startError }),
        build: '0.1.0',
        profile: profileDirectory() ?? '(not found)',
        credentials: channel.credentialSource,
        chats: list,
      }
    },
  })

  // Tell the model how this channel works and where the binding points.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const agent = context?.agent
    if (agent === undefined) return result
    const record = recordOf(agent)
    if (record === undefined) return result
    return {
      ...result,
      sections: [...(result.sections ?? []), { name: 'qgent:channel', order: 92, text: channelPrompt(record, settings) }],
    }
  })

  // Track turns for the fallback and turn-level error notice.
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.header?.id
    if (sessionId === undefined) return
    const record = sessions.bySessionId(sessionId)
    if (record === undefined) return
    if (event.type === 'turn/start') {
      tracker.begin(sessionId, Number(event.data?.turn ?? 0))
      return
    }
    if (event.type === 'assistant/message') {
      tracker.noteText(sessionId, messageText(event.data?.message))
      return
    }
    if (event.type === 'tool/call' || event.type === 'user/message') {
      // Interim text ("I'll look that up") is not a reply answer.
      tracker.clearText(sessionId)
      return
    }
    if (event.type !== 'turn/end') return
    const state = tracker.end(sessionId)
    const reason = event.data?.reason ?? {}
    if (reason.kind === 'error') {
      const detail = reason.error ?? reason.failure ?? {}
      const code = detail.code ?? reason.code ?? 'UNKNOWN'
      const message = detail.message ?? reason.message ?? 'unknown error'
      void channel.sendText(channel.entryFor(record), `⚠️ 这轮出错了（${code}）：${message}`).catch(error => {
        log.warn(`qgent: could not report the turn error: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    if (!settings.fallbackReply || state.sent) return
    const text = state.text
    if (text === '' || isSilenceReply(text)) return
    void channel.sendText(channel.entryFor(record), text).catch(error => {
      log.warn(`qgent: fallback send failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // Lifecycle: connect the bot, evict idle sessions, and clean up on unload.
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        sessions.evictIdle()
      } catch (error) {
        log.warn(`qgent: idle eviction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 5 * 60 * 1000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void sessions.disposeAll()
      channel.stop()
    }
  })

  const credentials = resolveCredentials(settings)
  // The old dsh-qqbot settings page stays installed (its bundle is kept for the
  // client UI); these routes make it read and edit qgent's own configuration.
  installSettingsRoutes(ctx, { settings, credentials, log, channel })
  if (credentials.appId === '' || credentials.appSecret === '') {
    log.warn('qgent: no QQ credentials (config, QQBOT_APPID/QQBOT_SECRET, or a bound im-qqbot row); the QQ channel stays offline')
    channel.startError = 'no credentials'
    channel.credentialSource = '(none)'
    return
  }
  settings.appId = credentials.appId
  settings.appSecret = credentials.appSecret
  channel.credentialSource = credentials.source
  sessions.setAppId(credentials.appId)
  log.info(`qgent: credentials from ${credentials.source}`)
  void channel.start()
}
