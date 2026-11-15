/**
 * dsh-music-player —— Host 半端
 *
 * 职责：
 *  1. 曲库：扫目录入库（自己下的 + 唧唧DOWN 的 Download 目录），音频和视频共用一套索引与歌单；
 *     索引存 %USERPROFILE%\.dsh\music-player\library.json；
 *  2. 下载：B 站搜索 → DASH 流 → 唧唧DOWN 自带 ffmpeg
 *     · 音频：音频流 → mp3
 *     · 视频：视频流(avc1) + 音频流 → -c copy 合并 mp4
 *     全程后台，不启动唧唧的窗口、也不碰它的界面；
 *  3. 网页端 HTTP 路由：状态、搜索、下载、媒体流（支持 Range）、封面代理、歌单、批量操作、点歌；
 *  4. 给模型一组工具：检索歌单、下载、整理曲库与歌单、遥控播放与视频窗。
 */
import { createReadStream, existsSync, promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { normalizeCover, searchVideos } from './lib/bili.js'
import { Downloader } from './lib/downloader.js'
import { DEFAULT_SHORTCUTS, MusicStore, defaultPaths } from './lib/store.js'

export const name = 'music-player'
export const inject = ['webServer', 'tools', 'agents']

const ROUTE = '/dsh-music'
const DATA_DIR = path.join(os.homedir(), '.dsh', 'music-player')

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'object' },
    items: { type: 'array', items: { type: 'object' } },
    tracks: { type: 'array', items: { type: 'object' } },
    playlists: { type: 'array', items: { type: 'object' } },
    playlist: { type: 'object' },
    jobs: { type: 'array', items: { type: 'object' } },
    done: { type: 'array', items: { type: 'object' } },
    pending: { type: 'array', items: { type: 'object' } },
    failed: { type: 'array', items: { type: 'object' } },
    counts: { type: 'object' },
    state: { type: 'object' },
    message: { type: 'string' },
  },
}
const TEXT_OUTPUT = { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function warn(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  } catch { /* 日志失败不影响功能 */ }
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/
const GRADIENT_RE = /^(linear|radial)-gradient\(/i

/**
 * 只收窄口子的皮肤补丁：颜色限定 hex/rgb/hsl，渐变限定 linear/radial-gradient，
 * 数值一律夹到合理区间，避免模型写出能砸掉界面的值。
 */
function pickSkinPatch(input, current) {
  const patch = {}
  for (const key of ['accent', 'surface', 'text']) {
    const value = String((input && input[key]) || '').trim()
    if (value && COLOR_RE.test(value)) patch[key] = value
  }
  const gradient = String((input && input.gradient) || '').trim()
  if (gradient && gradient.length <= 400 && GRADIENT_RE.test(gradient)
    && !/url\(|javascript:|expression\(/i.test(gradient)) {
    patch.gradient = gradient
  }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)))
  if (input && Number.isFinite(Number(input.blur))) patch.blur = clamp(input.blur, 0, 30)
  if (input && Number.isFinite(Number(input.opacity))) patch.opacity = clamp(input.opacity, 0.4, 1)
  if (input && Number.isFinite(Number(input.radius))) patch.radius = clamp(input.radius, 6, 28)
  if (input && Number.isFinite(Number(input.bgDim))) patch.bgDim = clamp(input.bgDim, 0, 0.9)
  if (input && input.glow !== undefined) patch.glow = Boolean(input.glow)
  if (input && input.anim !== undefined) patch.anim = Boolean(input.anim)
  const name = String((input && input.name) || '').trim().slice(0, 16)
  patch.preset = 'custom'
  patch.presetName = name || (current && current.presetName) || '自定义'
  return patch
}

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.flv': 'video/x-flv',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
}

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(String(file)).toLowerCase()] || 'application/octet-stream'
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        const error = new Error('请求体超过 ' + Math.round(limit / 1024) + ' KB')
        error.status = 413
        error.code = 'body_too_large'
        fail(error)
        try { req.destroy() } catch { /* 已经断了 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      // 按 Buffer 收齐再一次性解码：逐个 chunk 拼字符串会把跨边界的多字节字符切坏。
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        const wrapped = new Error('请求体不是合法 JSON：' + String((error && error.message) || error))
        wrapped.status = 400
        wrapped.code = 'bad_json'
        reject(wrapped)
      }
    })
    req.on('error', (error) => fail(error))
  })
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx, config) {
  const store = new MusicStore(DATA_DIR)
  let ready = false
  const readyWaiters = []
  const whenReady = () => (ready ? Promise.resolve() : new Promise((resolve) => { readyWaiters.push(resolve) }))

  const commands = []
  let playback = {
    playing: false,
    trackId: '',
    kind: 'audio',
    position: 0,
    queue: [],
    index: -1,
    volume: 0.75,
    repeat: 'all',
    shuffle: false,
    updatedAt: 0,
  }

  // 遥控命令靠状态整包投递，所以压命令时必须动 rev，否则客户端拿 304 永远看不到。
  const pushCommand = (action, value) => {
    commands.push({ id: randomUUID().slice(0, 8), action, value, at: Date.now() })
    while (commands.length > 20) commands.shift()
    store.rev += 1
  }

  // 最近一次被客户端轮询的时间：工具可以用它判断「有没有人在看」，别对空气说已播放。
  let lastClientPollAt = 0
  // existsSync 每 2 秒拉一次状态太亏，ffmpeg 是否存在缓存一分钟。
  let ffmpegReadyCache = { at: 0, value: false }
  const ffmpegAvailable = () => {
    const file = String(store.settings.ffmpegPath || '')
    if (!file) return false
    const now = Date.now()
    if (now - ffmpegReadyCache.at < 60000) return ffmpegReadyCache.value
    const value = existsSync(file)
    ffmpegReadyCache = { at: now, value }
    return value
  }

  const downloader = new Downloader(store, () => { store.rev += 1 })

  // ── 点歌代理：一次性子代理 ──────────────────────────────────────────
  // 以前的点歌是把话 followup 回「当前会话」：会话里攒了多少历史，模型就得读多少，
  // 聊上几轮就是几十万 token（旧会话 422 的根因之一）。现在每次点歌都通过
  // ctx.subagents.startActivation 起一个一次性子代理：
  //   · 预设 agentPreset=music —— 系统提示词只有一段曲库规则，不带人格、不带记忆；
  //   · 工作目录固定到「曲库搜索台」，子代理读不到当前会话的任何一轮对话；
  //   · 思考档位默认 low、模型 deepseek-flash —— 一次检索够用的最低开销；
  //   · delivery=caller：不往父会话写完成通知，结果直接回面板；
  //   · 跑完就把 activation 收掉，会话日志按 JSONL 落盘，下次不读。
  const askJobs = new Map()

  const noteAskDebug = (line) => {
    void fsp.appendFile(path.join(DATA_DIR, 'ask-debug.log'), new Date().toISOString() + ' ' + line + '\n').catch(() => {})
  }

  const askConfig = () => {
    const settings = store.settings || {}
    const text = (value) => (typeof value === 'string' ? value.trim() : '')
    return {
      fresh: settings.askFresh !== false,
      dir: text(settings.askDir) || path.join(DATA_DIR, 'search'),
      preset: text(settings.askPreset) || 'music',
      provider: text(settings.askProvider) || 'deepseek-official',
      model: text(settings.askModel) || 'deepseek-flash',
      effort: text(settings.askEffort),
      timeoutMs: Math.min(600000, Math.max(20000, Number(settings.askTimeoutMs) || 150000)),
    }
  }

  /** 从结果内容块里取纯文本。 */
  const blocksToText = (output) => {
    if (typeof output === 'string') return output.trim()
    if (Array.isArray(output)) {
      return output
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
        .trim()
    }
    if (output && Array.isArray(output.content)) return blocksToText(output.content)
    if (output && typeof output.text === 'string') return output.text.trim()
    return ''
  }

  /** 把调用方投递的结果写进 job，返回最终文本。 */
  const settleJob = (job, settled) => {
    if (settled && settled.error) {
      job.status = 'error'
      job.answer = String(settled.error && settled.error.message ? settled.error.message : settled.error)
    } else if (settled && settled.result) {
      const result = settled.result
      const reason = String(result.stopReason || 'completed')
      job.status = reason === 'completed' ? 'done' : reason
      job.answer = blocksToText(result.output)
      if (result.diagnostic) noteAskDebug('diagnostic ' + String(result.diagnostic).slice(0, 300))
    } else {
      job.status = 'done'
      job.answer = ''
    }
    job.endedAt = Date.now()
    return job.answer
  }

  /** 确保「曲库搜索台」工作区目录与分组登记都在（幂等）。 */
  const ensureAskWorkspace = async (dir) => {
    try {
      if (!existsSync(dir)) await fsp.mkdir(dir, { recursive: true })
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
      if (registry && typeof registry.create === 'function') await registry.create(dir, '曲库搜索台')
    } catch (error) {
      warn(ctx, '[music] 搜索台工作区初始化失败：' + String(error && error.message ? error.message : error))
    }
  }

  /** 起一个一次性子代理跑这次点歌，返回 { sessionId, answer, pending, status }。 */
  const runFreshAsk = async (parentSessionId, text, mode) => {
    const cfg = askConfig()
    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : null
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new Error('这台机器没挂 subagent 服务，点歌代理起不来')
    }
    // 单飞：上一次点歌还没回话就别再起一个，否则几个代理同时抢歌单/下载。
    const running = [...askJobs.values()].find(job => job.status === 'running' || job.status === 'pending')
    if (running) throw new Error('上一次点歌还在跑，等它回话再来')
    const parent = (() => {
      const exact = parentSessionId ? ctx.agents.get(parentSessionId) : null
      if (exact) return exact
      // 面板报上来的会话可能已经不在跑（在看历史记录）。委派必须有一个在线的父
      // agent，取最近注册的普通会话顶上——子代理的回话只走 caller 通道，不打扰它。
      const live = typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      for (let index = live.length - 1; index >= 0; index -= 1) {
        const agent = live[index]
        const origin = agent && agent.session && agent.session.header ? agent.session.header.origin : ''
        if (origin !== 'subagent') return agent
      }
      return null
    })()
    if (!parent) throw new Error('这台机器上没有跑着的会话：先打开一个会话，再点歌')
    await ensureAskWorkspace(cfg.dir)
    const controller = new AbortController()
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: '点歌 · ' + mode,
      prompt: [{ type: 'text', text }],
      parent,
      signal: controller.signal,
      delivery: 'caller',
      cwd: cfg.dir,
      agentPreset: cfg.preset,
      agentOptions: cfg.effort
        ? { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.effort }
        : { provider: cfg.provider, model: cfg.model },
    })
    const childId = String(activation.childId || '')
    const job = { sessionId: childId, mode, status: 'running', answer: '', startedAt: Date.now(), endedAt: 0 }
    if (childId) {
      askJobs.set(childId, job)
      // 只淘汰已经结束的 job：旧写法按插入序删，会把还在跑的删掉，面板查状态直接 404。
      while (askJobs.size > 20) {
        const stale = [...askJobs.values()].find(item => item.status !== 'running' && item.status !== 'pending')
        if (!stale) break
        const key = [...askJobs.keys()].find(key => askJobs.get(key) === stale)
        askJobs.delete(key)
      }
    }
    const collected = Promise.resolve(activation.result).then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    let timer = 0
    const outcome = await Promise.race([
      collected,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), cfg.timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
    if (timer) clearTimeout(timer)
    if (outcome === null) {
      // 超时：让它在后台跑完，面板用 /api/ask/status 拿结果（客户端会轮询）。
      job.status = 'pending'
      void collected.then((settled) => {
        settleJob(job, settled)
        return activation.dispose()
      }).catch(() => {})
      return { sessionId: childId, answer: '', pending: true, status: 'pending' }
    }
    const answer = settleJob(job, outcome)
    try { await activation.dispose() } catch { /* 已经收掉了 */ }
    return { sessionId: childId, answer, pending: false, status: job.status }
  }

  /** 点歌请求正文（模式说明 + 曲库现状）。 */
  const askText = (prompt, mode, think) => {
    const parts = ['\n\n（来自桌面播放器的请求']
    if (mode === 'organize') {
      parts.push('，模式：整理曲库。用 music_library 看现有曲目，用 music_playlist 建歌单并归类，不要下载新歌')
    } else if (mode === 'recommend') {
      parts.push('，模式：从现有曲库里推荐并直接用 music_player 播放，不要下载新歌')
    } else if (mode === 'skin') {
      parts.push('，模式：设计皮肤。先用一句话说出设计思路（配色意象、明暗、氛围），'
        + '再调用 music_skin 把完整配色写进皮肤：accent 主色 / surface 底色 / text 文字色 用 #RRGGBB，'
        + '可另给 gradient（linear-gradient(...) 或 radial-gradient(...)）作背景，'
        + '以及 blur 0~30、opacity 0.4~1、radius 6~28、glow/anim 布尔。配色要能看得清字，别搞成一坨')
    } else {
      parts.push('，模式：找歌。先用 music_search 检索候选，再用 music_download 下载到本地曲库并打 tags')
    }
    if (think) {
      parts.push('；先分步推理（想清楚要几个方向、每个方向搜什么词、怎么筛选），再动手，动手前不要反问我')
    }
    parts.push('。曲库现有 ' + store.list().length + ' 首'
      + (store.playlists.length ? '、' + store.playlists.length + ' 个歌单' : '')
      + (store.settings.downloadDir ? '；下载目录 ' + store.settings.downloadDir : '')
      + '）')
    return prompt + parts.join('')
  }

  const publicTrack = (track, playlistMap) => ({
    id: track.id,
    kind: track.kind,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    cover: track.cover,
    coverUrl: track.cover ? ROUTE + '/api/cover?u=' + encodeURIComponent(track.cover) : '',
    mediaUrl: ROUTE + '/media/' + encodeURIComponent(track.id),
    tags: track.tags,
    category: track.category,
    source: track.source,
    addedAt: track.addedAt,
    size: track.size,
    plays: track.plays,
    lastPlayedAt: track.lastPlayedAt,
    fav: track.fav,
    bv: track.bv,
    width: track.width,
    height: track.height,
    playlists: playlistMap ? (playlistMap.get(track.id) || []) : store.playlistsOf(track.id),
    name: track.name,
  })

  const scanAll = async () => {
    const settings = store.settings
    const added = []
    added.push(...await store.scanDirs([settings.downloadDir], { source: 'download' }))
    if (settings.scanJijidown && settings.jijidownDir) {
      added.push(...await store.scanDirs([settings.jijidownDir], { source: 'jijidown' }))
    }
    if (added.length) await store.save()
    return added
  }

  const buildState = () => {
    // 一次遍历建「曲目 → 歌单 id」映射，别在 publicTrack 里对每首歌都重扫一遍歌单。
    const playlistMap = new Map()
    for (const playlist of store.playlists) {
      for (const trackId of playlist.trackIds) {
        const list = playlistMap.get(trackId)
        if (list) list.push(playlist.id)
        else playlistMap.set(trackId, [playlist.id])
      }
    }
    // 遥控命令有时效：30 秒没人领就作废，免得半小时后打开面板突然自己放歌。
    const now = Date.now()
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      if (now - (commands[index].at || 0) > 30000) commands.splice(index, 1)
    }
    return {
      ok: true,
      rev: store.rev,
      settings: store.settings,
      tracks: store.list().map(track => publicTrack(track, playlistMap)),
      playlists: store.listPlaylists(),
      jobs: downloader.list(),
      playback,
      commands: commands.slice(),
      clientOnline: now - lastClientPollAt < 15000,
      paths: {
        dataDir: DATA_DIR,
        downloadDir: store.settings.downloadDir,
        jijidownDir: store.settings.jijidownDir,
        ffmpegReady: ffmpegAvailable(),
      },
    }
  }

  // ── 启动：载入索引、扫一遍目录 ──────────────────────────────────────
  ctx.effect(() => {
    let alive = true
    void (async () => {
      try {
        await store.load()
        if (!store.settings.jijidownDir) {
          const defaults = defaultPaths()
          if (defaults.jijidownDir) {
            store.settings.jijidownDir = defaults.jijidownDir
            store.settings.scanJijidown = true
          }
          if (!store.settings.ffmpegPath && defaults.ffmpegPath) store.settings.ffmpegPath = defaults.ffmpegPath
        }
        if (!alive) return
        ready = true
        for (const resolve of readyWaiters.splice(0)) resolve()
        const timer = setTimeout(() => {
          if (!alive) return
          void scanAll().catch((error) => warn(ctx, 'dsh-music-player: 扫目录失败 ' + (error && error.message)))
        }, 1200)
        if (typeof timer.unref === 'function') timer.unref()
        store._scanTimer = timer
      } catch (error) {
        ready = true
        for (const resolve of readyWaiters.splice(0)) resolve()
        warn(ctx, 'dsh-music-player: 载入曲库失败 ' + (error && error.message))
      }
    })()
    return () => {
      alive = false
      if (store._scanTimer) clearTimeout(store._scanTimer)
      downloader.stop()
      void store.save()
    }
  }, 'dsh-music-player: 曲库初始化')

  // ── HTTP 路由：一个前缀入口，内部再分发 ─────────────────────────────
  const handle = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    await whenReady()
    try {
      // 写请求必须带自定义头（会强制 CORS 预检，跨站发不出来），或者是同源页面自己发的。
      // 没有这道门，任意网页都能 text/plain POST 进来改设置（bgFile 读文件、ffmpegPath 跑程序）。
      if (method !== 'GET' && method !== 'HEAD' && req.headers['x-dsh-music-client'] !== '1') {
        const origin = String(req.headers.origin || '')
        const host = String(req.headers.host || '')
        const sameOrigin = origin !== '' && host !== '' && (origin === 'http://' + host || origin === 'https://' + host)
        if (!sameOrigin) {
          sendJson(res, 403, fail('forbidden', '缺少 X-DSH-Music-Client 头，拒绝来自非本页面的写请求'))
          return
        }
      }
      if (pathname === ROUTE + '/api/ping') {
        sendJson(res, 200, { ok: true, name, version: 2, rev: store.rev })
        return
      }
      if (pathname === ROUTE + '/api/state') {
        lastClientPollAt = Date.now()
        const state = buildState()
        const rev = url.searchParams.get('rev')
        if (rev && Number(rev) === state.rev) {
          res.writeHead(304, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        sendJson(res, 200, state)
        return
      }
      if (pathname === ROUTE + '/api/settings' && method === 'POST') {
        const body = await readBody(req)
        const settings = await store.patchSettings(body && body.patch ? body.patch : body)
        store.rev += 1
        sendJson(res, 200, { ok: true, settings })
        return
      }
      if (pathname === ROUTE + '/api/shortcuts/reset' && method === 'POST') {
        store.settings.shortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS))
        store.rev += 1
        await store.saveSettings()
        sendJson(res, 200, { ok: true, shortcuts: store.settings.shortcuts })
        return
      }
      if (pathname === ROUTE + '/api/migrate' && method === 'POST') {
        const body = await readBody(req)
        const from = String(body.from || store.settings.downloadDir || '')
        const to = String(body.to || '').trim()
        if (!to) { sendJson(res, 400, fail('no_target', '要给一个目标目录')); return }
        const result = await store.migrateDir(from, to)
        store.rev += 1
        sendJson(res, 200, { ok: true, ...result, movedTo: result.to })
        return
      }
      if (pathname === ROUTE + '/api/skin/bg') {
        const file = store.settings.skin && store.settings.skin.bgFile
        if (!file || !existsSync(file)) { res.writeHead(404); res.end('no background'); return }
        const ext = path.extname(file).toLowerCase()
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
        await serveMedia(req, res, file, type)
        return
      }
      if (pathname === ROUTE + '/api/skin/upload' && method === 'POST') {
        const body = await readBody(req, 16 * 1024 * 1024)
        const dataUrl = String(body.dataUrl || '')
        const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl)
        if (!match) { sendJson(res, 400, fail('bad_image', '只收 png / jpeg / webp 的图片')); return }
        const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
        const buffer = Buffer.from(match[2], 'base64')
        if (buffer.length > 12 * 1024 * 1024) { sendJson(res, 400, fail('too_large', '图片太大（上限 12MB）')); return }
        const skinDir = path.join(DATA_DIR, 'skin')
        await fsp.mkdir(skinDir, { recursive: true }).catch(() => {})
        const file = path.join(skinDir, 'bg.' + ext)
        await fsp.writeFile(file, buffer)
        const skin = { ...store.settings.skin, bgFile: file, bgStamp: Date.now(), preset: 'custom', presetName: store.settings.skin.presetName || '自定义' }
        await store.patchSettings({ skin })
        store.rev += 1
        sendJson(res, 200, { ok: true, skin: store.settings.skin, bytes: buffer.length })
        return
      }
      if (pathname === ROUTE + '/api/skin/clear' && method === 'POST') {
        const file = store.settings.skin && store.settings.skin.bgFile
        if (file) await fsp.unlink(file).catch(() => {})
        await store.patchSettings({ skin: { ...store.settings.skin, bgFile: '', bgStamp: Date.now() } })
        store.rev += 1
        sendJson(res, 200, { ok: true, skin: store.settings.skin })
        return
      }
      if (pathname === ROUTE + '/api/track' && method === 'POST') {
        const body = await readBody(req)
        const action = String(body.action || '')
        const id = String(body.id || '')
        if (action === 'update') {
          const track = store.updateTrack(id, body.patch || {})
          if (!track) { sendJson(res, 404, fail('not_found', '曲目不存在')); return }
          sendJson(res, 200, { ok: true, track: publicTrack(track) })
          return
        }
        if (action === 'remove') {
          try {
            const ok = await store.removeTrack(id, Boolean(body.deleteFile))
            sendJson(res, ok ? 200 : 404, ok ? { ok: true } : fail('not_found', '曲目不存在'))
          } catch (error) {
            // 文件被占用/没权限：索引没动，如实告诉面板。
            sendJson(res, 409, fail('file_locked', String((error && error.message) || error)))
          }
          return
        }
        if (action === 'play') {
          const track = store.get(id)
          if (track) store.updateTrack(id, { plays: track.plays + 1, lastPlayedAt: Date.now() })
          sendJson(res, 200, { ok: true })
          return
        }
        if (action === 'setDuration') {
          store.updateTrack(id, { duration: Number(body.duration) || 0 })
          sendJson(res, 200, { ok: true })
          return
        }
        if (action === 'setPlaylists') {
          const result = store.setTrackPlaylists(id, body.playlistIds)
          if (!result) { sendJson(res, 404, fail('not_found', '曲目不存在')); return }
          sendJson(res, 200, { ok: true, playlists: result })
          return
        }
        sendJson(res, 400, fail('bad_action', '未知操作'))
        return
      }
      if (pathname === ROUTE + '/api/batch' && method === 'POST') {
        const body = await readBody(req)
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
        const action = String(body.action || '')
        if (!ids.length) { sendJson(res, 400, fail('empty_ids', '没有选中任何曲目')); return }
        if (action === 'playlist') {
          const result = store.bulkPlaylist(String(body.playlistId || ''), ids, body.mode === 'remove' ? 'remove' : 'add')
          if (!result) { sendJson(res, 404, fail('not_found', '歌单不存在')); return }
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (action === 'remove') {
          let removed = 0
          const failed = []
          for (const id of ids) {
            try {
              if (await store.removeTrack(id, Boolean(body.deleteFile))) removed += 1
            } catch (error) {
              failed.push({ id, error: String((error && error.message) || error).slice(0, 120) })
            }
          }
          sendJson(res, 200, { ok: true, removed, ...(failed.length ? { failed } : {}) })
          return
        }
        if (action === 'favorite') {
          let updated = 0
          for (const id of ids) {
            if (store.updateTrack(id, { fav: Boolean(body.value) })) updated += 1
          }
          sendJson(res, 200, { ok: true, updated })
          return
        }
        if (action === 'category') {
          let updated = 0
          for (const id of ids) {
            if (store.updateTrack(id, { category: String(body.category || '未分类') })) updated += 1
          }
          sendJson(res, 200, { ok: true, updated })
          return
        }
        if (action === 'tags') {
          let updated = 0
          for (const id of ids) {
            if (store.updateTrack(id, { tags: Array.isArray(body.tags) ? body.tags : [] })) updated += 1
          }
          sendJson(res, 200, { ok: true, updated })
          return
        }
        sendJson(res, 400, fail('bad_action', '未知批量操作'))
        return
      }
      if (pathname === ROUTE + '/api/playlist' && method === 'POST') {
        const body = await readBody(req)
        const action = String(body.action || '')
        if (action === 'create') {
          const playlist = store.createPlaylist(body.name)
          store.rev += 1
          await store.save()
          sendJson(res, 200, { ok: true, playlist: { ...playlist, count: 0 } })
          return
        }
        if (action === 'rename') {
          const playlist = store.renamePlaylist(String(body.id || ''), body.name)
          if (!playlist) { sendJson(res, 404, fail('not_found', '歌单不存在')); return }
          await store.save()
          sendJson(res, 200, { ok: true, playlist: { ...playlist, count: playlist.trackIds.length } })
          return
        }
        if (action === 'delete') {
          const ok = store.deletePlaylist(String(body.id || ''))
          if (ok) await store.save()
          sendJson(res, ok ? 200 : 404, ok ? { ok: true } : fail('not_found', '歌单不存在'))
          return
        }
        if (action === 'add' || action === 'remove') {
          const ids = Array.isArray(body.trackIds) ? body.trackIds.map(String) : []
          if (!ids.length) { sendJson(res, 400, fail('empty_ids', '没有选中任何曲目')); return }
          const result = store.bulkPlaylist(String(body.id || ''), ids, action)
          if (!result) { sendJson(res, 404, fail('not_found', '歌单不存在')); return }
          await store.save()
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        sendJson(res, 400, fail('bad_action', '未知歌单操作'))
        return
      }
      if (pathname === ROUTE + '/api/scan' && method === 'POST') {
        const body = await readBody(req)
        const dirs = Array.isArray(body.dirs) ? body.dirs.filter(dir => typeof dir === 'string') : []
        const added = await scanAll()
        if (dirs.length) added.push(...await store.scanDirs(dirs, { source: 'manual' }))
        await store.save()
        sendJson(res, 200, { ok: true, added: added.map(publicTrack), total: store.list().length })
        return
      }
      if (pathname === ROUTE + '/api/search') {
        const query = String(url.searchParams.get('q') || '').trim()
        if (!query) { sendJson(res, 400, fail('empty_query', '搜索词不能为空')); return }
        const items = await searchVideos(query, {
          page: Number(url.searchParams.get('page')) || 1,
          limit: Math.max(1, Math.min(30, Number(url.searchParams.get('limit')) || 15)),
        })
        sendJson(res, 200, { ok: true, query, items })
        return
      }
      if (pathname === ROUTE + '/api/download' && method === 'POST') {
        const body = await readBody(req)
        const rawItems = Array.isArray(body.items) ? body.items : []
        const defaultKind = body.kind === 'video' ? 'video' : 'audio'
        const items = rawItems.map(item => ({
          bvid: String(item.bvid || ''),
          kind: item.kind === 'video' || item.kind === 'audio' ? item.kind : defaultKind,
          title: String(item.title || ''),
          artist: String(item.artist || ''),
          tags: Array.isArray(item.tags) ? item.tags : (Array.isArray(body.tags) ? body.tags : []),
          category: String(item.category || body.category || ''),
          playlistId: String(item.playlistId || body.playlistId || ''),
        })).filter(item => /^BV[0-9A-Za-z]+$/.test(item.bvid))
        if (!items.length) { sendJson(res, 400, fail('empty_items', '没有有效的 BV 号')); return }
        const accepted = downloader.enqueue(items)
        sendJson(res, 200, { ok: true, jobs: accepted.map(job => job.id), count: accepted.length })
        return
      }
      if (pathname === ROUTE + '/api/jobs') {
        sendJson(res, 200, { ok: true, jobs: downloader.list(), active: downloader.active() })
        return
      }
      if (pathname === ROUTE + '/api/jobs/clear' && method === 'POST') {
        downloader.clearFinished()
        sendJson(res, 200, { ok: true })
        return
      }
      if (pathname === ROUTE + '/api/playback' && method === 'POST') {
        const body = await readBody(req)
        // 白名单收敛：这里是所有窗口共用的播放状态，别让任意字段/类型灌进去。
        const next = { ...playback }
        if (body && typeof body === 'object') {
          if (typeof body.playing === 'boolean') next.playing = body.playing
          if (body.kind === 'audio' || body.kind === 'video') next.kind = body.kind
          if (Number.isFinite(Number(body.position))) next.position = Math.min(86400, Math.max(0, Number(body.position)))
          if (Number.isFinite(Number(body.duration))) next.duration = Math.max(0, Number(body.duration))
          if (Number.isFinite(Number(body.volume))) next.volume = Math.min(1, Math.max(0, Number(body.volume)))
          if (body.repeat === 'off' || body.repeat === 'all' || body.repeat === 'one') next.repeat = body.repeat
          if (typeof body.shuffle === 'boolean') next.shuffle = body.shuffle
          if (Array.isArray(body.queue)) next.queue = body.queue.slice(0, 500).map(String)
          if (typeof body.videoOpen === 'number') next.videoOpen = body.videoOpen ? 1 : 0
          if (typeof body.clientBuild === 'string') next.clientBuild = body.clientBuild.slice(0, 16)
          if (typeof body.trackId === 'string' && (!body.trackId || store.get(body.trackId))) next.trackId = body.trackId
        }
        playback = { ...next, updatedAt: Date.now() }
        const track = playback.trackId ? store.get(playback.trackId) : null
        if (track && Number(playback.duration) > 0 && !track.duration) {
          store.updateTrack(track.id, { duration: Number(playback.duration) })
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (pathname === ROUTE + '/api/command-ack' && method === 'POST') {
        const body = await readBody(req)
        const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])
        const before = commands.length
        for (let index = commands.length - 1; index >= 0; index -= 1) {
          if (ids.has(commands[index].id)) commands.splice(index, 1)
        }
        // 命令队列变了要动 rev：否则 304 会让下一个窗口以为没变化。
        if (commands.length !== before) store.rev += 1
        sendJson(res, 200, { ok: true, left: commands.length })
        return
      }
      if (pathname === ROUTE + '/api/ask' && method === 'POST') {
        const body = await readBody(req)
        const prompt = String(body.prompt || '').trim().slice(0, 2000)
        const sessionId = String(body.sessionId || '').trim()
        const mode = String(body.mode || 'discover')
        const think = body.think !== false
        if (!prompt) { sendJson(res, 400, fail('empty_prompt', '点歌内容不能为空')); return }
        const text = askText(prompt, mode, think)
        const cfg = askConfig()
        if (cfg.fresh) {
          try {
            const result = await runFreshAsk(sessionId, text, mode)
            sendJson(res, 200, { ok: true, fresh: true, mode, prompt: prompt.slice(0, 120), ...result })
          } catch (error) {
            sendJson(res, 500, fail('fresh_ask_failed', String(error && error.message ? error.message : error)))
          }
          return
        }
        if (!sessionId) { sendJson(res, 400, fail('no_session', '当前没有会话，请先打开一个会话再点歌')); return }
        const agent = ctx.agents.get(sessionId)
        if (!agent) { sendJson(res, 404, fail('no_agent', '这个会话还没启动，请稍后再试')); return }
        try {
          agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
          sendJson(res, 200, { ok: true, fresh: false })
        } catch (error) {
          sendJson(res, 500, fail('followup_failed', String(error && error.message ? error.message : error)))
        }
        return
      }
      if (pathname === ROUTE + '/api/ask/status') {
        const id = String(url.searchParams.get('id') || '')
        const job = askJobs.get(id)
        if (!job) { sendJson(res, 404, fail('no_job', '没有这次点歌记录')); return }
        sendJson(res, 200, { ok: true, job })
        return
      }
      if (pathname === ROUTE + '/api/debug/agents') {
        const agents = typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
        sendJson(res, 200, {
          ok: true,
          agents: agents.map(agent => ({
            id: String(agent.id),
            cwd: String((agent.session && agent.session.header && agent.session.header.cwd) || ''),
            preset: String((agent.session && agent.session.header && agent.session.header.agentPreset) || ''),
          })),
        })
        return
      }
      if (pathname === ROUTE + '/api/cover') {
        const target = String(url.searchParams.get('u') || '')
        const norm = normalizeCover(target)
        if (!norm) { res.writeHead(400); res.end('bad cover'); return }
        const cached = coverCache.get(norm)
        if (cached && Date.now() - cached.at < 6 * 3600 * 1000) {
          res.writeHead(200, { 'content-type': cached.type, 'content-length': cached.body.length, 'cache-control': 'public, max-age=86400' })
          res.end(cached.body)
          return
        }
        let remote
        try {
          remote = await fetch(norm, {
            headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
            signal: AbortSignal.timeout(8000),
          })
        } catch {
          res.writeHead(504); res.end('cover timeout'); return
        }
        if (!remote.ok) { res.writeHead(502); res.end('cover fetch failed'); return }
        const type = String(remote.headers.get('content-type') || 'image/jpeg')
        if (!/^image\//i.test(type)) { res.writeHead(415); res.end('not an image'); return }
        const body = Buffer.from(await remote.arrayBuffer())
        if (body.length > 4 * 1024 * 1024) { res.writeHead(413); res.end('cover too large'); return }
        // 按条数淘汰只清一次全表，太粗；按体积留最近 12MB。
        let bytes = 0
        for (const entry of coverCache.values()) bytes += entry.body.length
        while (coverCache.size > 0 && (coverCache.size > 60 || bytes + body.length > 12 * 1024 * 1024)) {
          const oldest = coverCache.keys().next().value
          const dropped = coverCache.get(oldest)
          if (dropped) bytes -= dropped.body.length
          coverCache.delete(oldest)
        }
        coverCache.set(norm, { at: Date.now(), type, body })
        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'public, max-age=86400' })
        res.end(body)
        return
      }
      if (pathname.startsWith(ROUTE + '/media/') || pathname.startsWith(ROUTE + '/audio/')) {
        const prefix = pathname.startsWith(ROUTE + '/media/') ? ROUTE + '/media/' : ROUTE + '/audio/'
        const id = decodeURIComponent(pathname.slice(prefix.length))
        const track = store.get(id)
        if (!track) { res.writeHead(404); res.end('not found'); return }
        await serveMedia(req, res, track.file)
        return
      }
      sendJson(res, 404, fail('not_found', 'not found'))
    } catch (error) {
      try {
        // readBody 抛出来的 400/413 之类带上自己的状态码，别一律 500。
        const status = Number(error && error.status) || 500
        const code = String((error && error.code) || 'route_error')
        sendJson(res, status, fail(code, String(error && error.message ? error.message : error)))
      } catch { /* 响应已结束 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }), 'dsh-music-player: 路由')

  // ── 工具：让模型自己找歌、下载、整理歌单、遥控 ──────────────────────
  const tools = [
    {
      name: 'music_search',
      description:
        '在 B 站检索视频/歌曲，返回候选（BV 号、标题、UP 主、时长秒数、封面）。点歌、找歌单时先用它探路；'
        + '一次最多 30 条，长尾关键词可以换着搜。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '搜索关键词，可以是歌名、歌手、曲风、语种、梗，也可以是视频主题。' },
          limit: { type: 'number', description: '返回条数，1~30，默认 15。' },
          page: { type: 'number', description: '页码，默认 1。' },
        },
        required: ['query'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        await whenReady()
        const query = String((args && args.query) || '').trim()
        if (!query) return fail('empty_query', 'query 不能为空')
        const items = await searchVideos(query, {
          page: Number(args.page) || 1,
          limit: Math.max(1, Math.min(30, Number(args.limit) || 15)),
        })
        return { ok: true, query, count: items.length, items }
      },
    },
    {
      name: 'music_download',
      description:
        '把选好的 BV 号下载到本地曲库：kind=audio 出 mp3，kind=video 出 mp4（DASH 视频流优先 avc1 + 音轨合并）。'
        + '全程后台、不弹唧唧窗口。每首可带 tags（曲风/语种）与 category，便于之后分类；'
        + '默认最多等 60 秒回执，超时的仍在后台继续下。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            description: '要下载的曲目/视频，一项一个。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bvid: { type: 'string', description: 'BV 号，例如 BV1xx411c7mD。' },
                kind: { type: 'string', enum: ['audio', 'video'], description: '可选，audio=mp3，video=mp4；不填用外层 kind。' },
                title: { type: 'string', description: '可选，标题（不填就取 B 站原标题）。' },
                tags: { type: 'array', items: { type: 'string' }, description: '可选，标签，例如 鬼畜 / 日语 / 节奏感。' },
                category: { type: 'string', description: '可选，分类名，例如 日语节奏。' },
              },
              required: ['bvid'],
            },
          },
          kind: { type: 'string', enum: ['audio', 'video'], description: '可选，整批默认下载类型，默认 audio。' },
          category: { type: 'string', description: '可选，给这一批统一分类。' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选，给这一批统一标签。' },
          playlistId: { type: 'string', description: '可选，下载完成后直接加进这个歌单。' },
          waitSeconds: { type: 'number', description: '等待多少秒再回执，0 表示立刻返回，默认 60，上限 240。' },
        },
        required: ['items'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        await whenReady()
        const rawItems = Array.isArray(args && args.items) ? args.items : []
        const mapped = rawItems.map(item => ({
          bvid: String((item && item.bvid) || ''),
          kind: item && (item.kind === 'video' || item.kind === 'audio') ? item.kind : (args.kind === 'video' ? 'video' : 'audio'),
          title: String((item && item.title) || ''),
          tags: Array.isArray(item && item.tags) ? item.tags : (Array.isArray(args.tags) ? args.tags : []),
          category: String((item && item.category) || args.category || ''),
          playlistId: String((item && item.playlistId) || args.playlistId || ''),
        })).filter(item => /^BV[0-9A-Za-z]+$/.test(item.bvid))
        if (!mapped.length) return fail('empty_items', 'items 里没有合法的 BV 号')
        let playlistName = ''
        if (args.playlistId) {
          const playlist = store.getPlaylist(String(args.playlistId))
          playlistName = playlist ? playlist.name : ''
        }
        const accepted = downloader.enqueue(mapped)
        const waitMs = Math.max(0, Math.min(240, args.waitSeconds === 0 ? 0 : (Number(args.waitSeconds) || 60))) * 1000
        const deadline = Date.now() + waitMs
        const ids = new Set(accepted.map(job => job.id))
        while (Date.now() < deadline) {
          const jobs = downloader.list().filter(job => ids.has(job.id))
          if (jobs.every(job => job.status !== 'queued' && job.status !== 'running')) break
          await new Promise(resolve => setTimeout(resolve, 800))
        }
        const jobs = downloader.list().filter(job => ids.has(job.id))
        const done = jobs.filter(job => job.status === 'done' || job.status === 'skip')
        const failed = jobs.filter(job => job.status === 'error')
        const pending = jobs.filter(job => job.status === 'queued' || job.status === 'running')
        // 队列满时会被丢掉的 job：在查得到的集合里对不上号的那些 BV。
        const missing = mapped.map(item => item.bvid).filter(bvid => !jobs.some(job => job.bvid === bvid))
        const playlistNote = playlistName ? '，全部自动进歌单「' + playlistName + '」' : ''
        const allSettled = pending.length === 0 && missing.length === 0 && failed.length === 0
        return {
          ok: allSettled,
          accepted: ids.size,
          done: done.map(job => ({ bvid: job.bvid, kind: job.kind, title: job.title, trackId: job.trackId })),
          pending: pending.map(job => ({ bvid: job.bvid, kind: job.kind, title: job.title, phase: job.phase, progress: job.progress })),
          failed: failed.map(job => ({ bvid: job.bvid, title: job.title, error: job.error })),
          ...missing.length ? { missing } : {},
          message: (failed.length
            ? failed.length + ' 个下载失败'
            : allSettled
              ? '全部处理完了'
              : pending.length
                ? '还有 ' + pending.length + ' 个在后台下载，完成后会自动出现在曲库里'
                : '有 ' + missing.length + ' 个没排进队列（排队已满），请稍后重下') + playlistNote + '。',
        }
      },
    },
    {
      name: 'music_playlist',
      description:
        '管理歌单：list 列出全部歌单（含每单曲目数）、create 新建、add 把曲目加进歌单、remove 移出、'
        + 'rename 改名、delete 删除、detail 看某单曲目、of 看一首歌在哪些歌单里。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'add', 'remove', 'rename', 'delete', 'detail', 'of'] },
          id: { type: 'string', description: '歌单 id（create 不用给）。' },
          name: { type: 'string', description: 'create/rename 用的歌单名。' },
          trackIds: { type: 'array', items: { type: 'string' }, description: 'add/remove 用的曲目 id 列表。' },
          trackId: { type: 'string', description: 'of 用的单首曲目 id。' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        await whenReady()
        const action = String((args && args.action) || 'list')
        if (action === 'list') {
          return { ok: true, playlists: store.listPlaylists(), counts: { total: store.playlists.length } }
        }
        if (action === 'create') {
          const playlist = store.createPlaylist(args.name)
          await store.save()
          return { ok: true, playlist: { ...playlist, count: 0 } }
        }
        if (action === 'rename') {
          const playlist = store.renamePlaylist(String(args.id || ''), args.name)
          if (!playlist) return fail('not_found', '歌单不存在')
          await store.save()
          return { ok: true, playlist: { ...playlist, count: playlist.trackIds.length } }
        }
        if (action === 'delete') {
          const ok = store.deletePlaylist(String(args.id || ''))
          if (ok) await store.save()
          return ok ? { ok: true } : fail('not_found', '歌单不存在')
        }
        if (action === 'detail') {
          const playlist = store.getPlaylist(String(args.id || ''))
          if (!playlist) return fail('not_found', '歌单不存在')
          return {
            ok: true,
            playlist: { id: playlist.id, name: playlist.name, count: playlist.trackIds.length },
            tracks: playlist.trackIds.map(id => store.get(id)).filter(Boolean).map(publicTrack),
          }
        }
        if (action === 'of') {
          const track = store.get(String(args.trackId || ''))
          if (!track) return fail('not_found', '曲目不存在')
          return {
            ok: true,
            track: { id: track.id, title: track.title },
            playlists: store.playlistsOf(track.id).map(id => {
              const playlist = store.getPlaylist(id)
              return { id, name: playlist ? playlist.name : id }
            }),
          }
        }
        const ids = Array.isArray(args.trackIds) ? args.trackIds.map(String) : []
        if (!ids.length) return fail('empty_ids', 'trackIds 不能为空')
        const result = store.bulkPlaylist(String(args.id || ''), ids, action === 'remove' ? 'remove' : 'add')
        if (!result) return fail('not_found', '歌单不存在')
        await store.save()
        return { ok: true, ...result }
      },
    },
    {
      name: 'music_library',
      description:
        '管理本地曲库：list 看清单（可按分类/标签/类型/关键词过滤）、update 改标题/歌手/标签/分类、'
        + 'remove 移除（可连文件一起删）、scan 重扫下载目录、stats 看统计、'
        + 'migrate 把媒体文件整体挪到别的目录（会同步索引与下载目录）。kind 可筛 audio / video。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'update', 'remove', 'scan', 'stats', 'migrate'] },
          filter: { type: 'string', description: 'list 用：标题/歌手/标签里含这个字就留下。' },
          kind: { type: 'string', enum: ['audio', 'video', 'all'], description: 'list 用：只看音频或视频。' },
          limit: { type: 'number', description: 'list 用：最多返回多少条，默认 50。' },
          id: { type: 'string', description: 'update/remove 用：曲目 id。' },
          patch: {
            type: 'object',
            description: 'update 用：可改 title / artist / tags / category / fav。',
            additionalProperties: true,
          },
          deleteFile: { type: 'boolean', description: 'remove 用：是否连文件一起删（默认只从曲库移除）。' },
          to: { type: 'string', description: 'migrate 用：目标目录，例如 E:\\DshMusic' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        await whenReady()
        const action = String((args && args.action) || 'list')
        if (action === 'scan') {
          const added = await scanAll()
          await store.save()
          return { ok: true, added: added.map(publicTrack), counts: { total: store.list().length } }
        }
        if (action === 'stats') {
          const tracks = store.list()
          const byCategory = {}
          const byKind = { audio: 0, video: 0 }
          for (const track of tracks) {
            byCategory[track.category] = (byCategory[track.category] || 0) + 1
            byKind[track.kind] = (byKind[track.kind] || 0) + 1
          }
          return {
            ok: true,
            counts: {
              total: tracks.length,
              byKind,
              withCover: tracks.filter(track => track.cover).length,
              byCategory,
              playlists: store.listPlaylists().map(playlist => ({ id: playlist.id, name: playlist.name, count: playlist.count })),
              downloadDir: store.settings.downloadDir,
              jijidownDir: store.settings.jijidownDir,
              ffmpegReady: Boolean(store.settings.ffmpegPath && existsSync(store.settings.ffmpegPath)),
              activeJobs: downloader.list().filter(job => job.status === 'queued' || job.status === 'running').length,
            },
          }
        }
        if (action === 'update') {
          const track = store.updateTrack(String(args.id || ''), args.patch || {})
          if (!track) return fail('not_found', '曲目不存在')
          return { ok: true, track: publicTrack(track) }
        }
        if (action === 'remove') {
          try {
            const ok = await store.removeTrack(String(args.id || ''), Boolean(args.deleteFile))
            return ok ? { ok: true } : fail('not_found', '曲目不存在')
          } catch (error) {
            return fail('file_locked', String((error && error.message) || error))
          }
        }
        if (action === 'migrate') {
          const to = String(args.to || '').trim()
          if (!to) return fail('no_target', '要给一个目标目录')
          const result = await store.migrateDir(store.settings.downloadDir, to)
          store.rev += 1
          return { ok: result.failed.length === 0, counts: { moved: result.moved, failed: result.failed.length }, movedTo: result.to, failed: result.failed }
        }
        const needle = String((args && args.filter) || '').trim().toLowerCase()
        const kind = args.kind === 'audio' || args.kind === 'video' ? args.kind : 'all'
        const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 50))
        let tracks = store.list()
        if (kind !== 'all') tracks = tracks.filter(track => track.kind === kind)
        if (needle) {
          tracks = tracks.filter(track => (track.title + ' ' + track.artist + ' ' + track.tags.join(' ') + ' ' + track.category)
            .toLowerCase().includes(needle))
        }
        return {
          ok: true,
          tracks: tracks.slice(0, limit).map(publicTrack),
          counts: { matched: tracks.length, total: store.list().length, playlists: store.playlists.length },
        }
      },
    },
    {
      name: 'music_player',
      description:
        '遥控桌面播放器。action：status 看状态、play/pause/toggle 播放暂停、next/prev 切歌、volume 调音量(0~1)、'
        + 'seek 跳秒、repeat 循环模式(off/all/one)、shuffle 随机开关、play_track 指定曲目、play_bvid 播某首、'
        + 'video_window 打开/关闭视频窗口、open 展开面板、close 收起面板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'play', 'pause', 'toggle', 'next', 'prev', 'volume', 'seek', 'repeat', 'shuffle', 'play_track', 'play_bvid', 'video_window', 'open', 'close'],
          },
          value: { type: 'string', description: 'volume 用数字字符串；repeat 用 off/all/one；shuffle/video_window 用 true/false。' },
          id: { type: 'string', description: 'play_track 用的曲目 id。' },
          bvid: { type: 'string', description: 'play_bvid 用的 BV 号。' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        await whenReady()
        const action = String((args && args.action) || 'status')
        if (action === 'status') {
          const current = playback.trackId ? store.get(playback.trackId) : null
          return {
            ok: true,
            state: {
              playing: Boolean(playback.playing),
              track: current ? publicTrack(current) : null,
              position: Number(playback.position) || 0,
              volume: Number(playback.volume) || 0,
              repeat: playback.repeat,
              shuffle: Boolean(playback.shuffle),
              queueLength: Array.isArray(playback.queue) ? playback.queue.length : 0,
              tracks: store.list().length,
              playlists: store.playlists.length,
            },
          }
        }
        // 遥控是「投递命令、等客户端来领」，所以回话要诚实：没人在线就说排队，
        // 别让模型回用户「给你放着呢」而实际上没人执行。
        const dispatch = (command, value, doneText) => {
          pushCommand(command, value)
          const online = Date.now() - lastClientPollAt < 15000
          return {
            ok: true,
            clientOnline: online,
            message: online ? doneText : doneText + '（播放器现在没在线，命令已排队，打开面板后生效）',
          }
        }
        if (action === 'play_track') {
          const track = store.get(String(args.id || ''))
          if (!track) return fail('not_found', '曲目不存在')
          return dispatch('playTrack', track.id, '已让播放器播放《' + track.title + '》')
        }
        if (action === 'play_bvid') {
          const bvid = String(args.bvid || '').trim()
          const track = store.list().find(item => item.bv === bvid)
          if (!track) return fail('not_found', '曲库里还没有这首（可能还在下载）')
          return dispatch('playTrack', track.id, '已让播放器播放《' + track.title + '》')
        }
        if (action === 'volume') {
          const volume = Math.max(0, Math.min(1, Number(args.value)))
          if (!Number.isFinite(volume)) return fail('bad_value', 'value 要给 0~1 的数字')
          return dispatch('volume', volume, '音量已设为 ' + Math.round(volume * 100) + '%')
        }
        if (action === 'seek') {
          const position = Math.max(0, Number(args.value) || 0)
          return dispatch('seek', position, '已跳到 ' + Math.round(position) + ' 秒')
        }
        if (action === 'repeat') {
          const mode = String(args.value || 'all')
          if (!['off', 'all', 'one'].includes(mode)) return fail('bad_value', 'repeat 只支持 off/all/one')
          return dispatch('repeat', mode, '循环模式：' + mode)
        }
        if (action === 'shuffle') {
          const on = String(args.value || 'true') !== 'false'
          return dispatch('shuffle', on, on ? '随机播放已开' : '随机播放已关')
        }
        if (action === 'video_window') {
          const open = String(args.value || 'true') !== 'false'
          return dispatch('videoWindow', open, open ? '已打开视频窗口' : '已关闭视频窗口')
        }
        if (action === 'open' || action === 'close') {
          return dispatch(action === 'open' ? 'openPanel' : 'closePanel', undefined, action === 'open' ? '已展开面板' : '已收起面板')
        }
        return dispatch(action, args.value, '已下发 ' + action)
      },
    },
    {
      name: 'music_skin',
      description:
        '设计/应用播放器皮肤。action=apply 时传一套配色（accent 主色 / surface 底色 / text 文字色 用 #RRGGBB，'
        + '可另给 gradient 作为背景渐变、blur 0~30、opacity 0.4~1、radius 6~28、glow/anim 开关、bgDim 背景压暗 0~0.9）；'
        + 'action=get 看当前皮肤，action=reset 恢复默认。用户让你"设计个 XX 风格的皮肤"时用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['apply', 'get', 'reset'] },
          name: { type: 'string', description: '给这套皮肤起个名字，例如「赛博霓虹」' },
          accent: { type: 'string', description: '主色，#RRGGBB' },
          surface: { type: 'string', description: '底色，#RRGGBB' },
          text: { type: 'string', description: '文字颜色，#RRGGBB' },
          gradient: { type: 'string', description: '可选背景渐变，例如 linear-gradient(140deg,#0a0f1a,#1b2b46)' },
          blur: { type: 'number', description: '毛玻璃模糊 0~30' },
          opacity: { type: 'number', description: '面板不透明度 0.4~1' },
          radius: { type: 'number', description: '圆角 6~28' },
          glow: { type: 'boolean', description: '氛围光' },
          anim: { type: 'boolean', description: '动画开关' },
          bgDim: { type: 'number', description: '自定义背景图的压暗程度 0~0.9' },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        await whenReady()
        const action = String((args && args.action) || 'get')
        if (action === 'get') return { ok: true, state: { skin: store.settings.skin } }
        if (action === 'reset') {
          const skin = {
            preset: 'deepsea', presetName: '', accent: '#54b8ff', surface: '#0b1422', text: '#e9f2ff',
            blur: 18, opacity: 0.82, radius: 18, glow: true, anim: true,
            gradient: '', bgDim: 0.35, bgBlur: 0,
            bgFile: store.settings.skin.bgFile, bgStamp: store.settings.skin.bgStamp,
          }
          await store.patchSettings({ skin })
          store.rev += 1
          return { ok: true, state: { skin: store.settings.skin }, message: '皮肤已恢复默认' }
        }
        const patch = pickSkinPatch(args, store.settings.skin)
        if (Object.keys(patch).length <= 2) return fail('empty_patch', '没有可以应用的有效配色字段')
        await store.patchSettings({ skin: { ...store.settings.skin, ...patch } })
        store.rev += 1
        return {
          ok: true,
          state: { skin: store.settings.skin },
          message: '皮肤「' + patch.presetName + '」已应用',
        }
      },
    },
  ]

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), 'dsh-music-player: ' + definition.name)
  }
}

// ── 媒体流（支持 Range，播放器才能拖进度条；视频同理） ─────────────────
const coverCache = new Map()

async function serveMedia(req, res, file, overrideType) {
  let stat
  try { stat = await fsp.stat(file) } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('媒体文件不存在：' + path.basename(file))
    return
  }
  const total = stat.size
  const type = overrideType || mimeOf(file)
  const range = req.headers.range
  const etag = '"' + total.toString(36) + '-' + Math.round(stat.mtimeMs).toString(36) + '"'
  // 打开流并接管错误：不接的话，文件在 stat 之后被删/被搬/盘掉线，
  // 'error' 会以 uncaughtException 冒到进程级，把整个宿主带走。
  const pipe = (options) => {
    let stream
    try { stream = createReadStream(file, options) } catch (error) {
      warn(null, 'dsh-music-player: 打开媒体失败 ' + String((error && error.message) || error))
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      try { res.end('媒体打不开') } catch { /* 已经断了 */ }
      return
    }
    stream.on('error', (error) => {
      warn(null, 'dsh-music-player: 读媒体失败 ' + String((error && error.message) || error))
      try { res.destroy() } catch { /* 已经断了 */ }
    })
    res.on('close', () => { try { stream.destroy() } catch { /* ignore */ } })
    stream.pipe(res)
  }
  const headOnly = (req.method || 'GET').toUpperCase() === 'HEAD'

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : total - 1
      if (!match[1] && match[2]) { start = Math.max(0, total - Number(match[2])); end = total - 1 }
      // end < start（例如 bytes=100-50）必须 416：否则 content-length 是负数，
      // createReadStream 同步抛错、HEADERS_SENT 之后连 500 都写不回去，请求就永久挂着。
      if (Number.isNaN(start) || Number.isNaN(end) || start >= total || end < start) {
        res.writeHead(416, { 'content-range': 'bytes */' + total, 'accept-ranges': 'bytes' })
        res.end()
        return
      }
      end = Math.min(end, total - 1)
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': 'bytes ' + start + '-' + end + '/' + total,
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=0',
        'last-modified': stat.mtime.toUTCString(),
        etag,
      })
      if (headOnly) { res.end(); return }
      pipe({ start, end })
      return
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=0',
    'last-modified': stat.mtime.toUTCString(),
    etag,
  })
  if (headOnly) { res.end(); return }
  pipe()
}

export const __internals = { mimeOf, serveMedia, fsp }
