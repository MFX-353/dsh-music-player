/**
 * B 站接口客户端（Host 侧）。
 *
 * 只做四件事：搜索、取视频信息、取音频直链、把音频流下载到临时文件。
 * 走的是唧唧DOWN 同一条路：B 站 DASH 音频流 → 本机 ffmpeg（唧唧自带的那个）转 mp3。
 * 关键点：B 站风控要求先拿 buvid3 之类的 cookie，否则一律 412。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const SEARCH_REFERER = 'https://search.bilibili.com/'
const SITE_REFERER = 'https://www.bilibili.com/'

/** cookie 仓库：内存缓存 + 412 时自动重取。 */
class CookieJar {
  constructor() {
    this.cookie = ''
    this.booting = null
    this.failedAt = 0
  }

  async ensure() {
    if (this.cookie) return this.cookie
    // 没拿到 cookie 时别每次请求都重拉首页（一次下载能白拉十几次），失败缓存 60 秒。
    if (this.failedAt && Date.now() - this.failedAt < 60000) return ''
    if (!this.booting) {
      this.booting = this.bootstrap()
        .then((value) => {
          if (!value) this.failedAt = Date.now()
          return value
        })
        .catch(() => {
          this.failedAt = Date.now()
          return ''
        })
        .finally(() => { this.booting = null })
    }
    return this.booting
  }

  async bootstrap() {
    const res = await fetch('https://www.bilibili.com/', {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(15000),
    })
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean)
    await res.text().catch(() => '')
    const pairs = raw
      .map(line => String(line).split(';')[0])
      .filter(pair => pair.includes('='))
    this.cookie = pairs.join('; ')
    if (this.cookie) this.failedAt = 0
    return this.cookie
  }

  async reset() {
    this.cookie = ''
    this.failedAt = 0
    return this.ensure()
  }
}

export const jar = new CookieJar()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 调一个 B 站 JSON 接口，412（风控）时换一次 cookie 重试。
 * @param {string} url 完整地址
 * @param {{ referer?: string, retry?: number }} [options]
 * @returns {Promise<any>}
 */
export async function biliJson(url, options = {}) {
  const referer = options.referer || SEARCH_REFERER
  let lastError
  for (let attempt = 0; attempt <= (options.retry ?? 2); attempt += 1) {
    const cookie = await jar.ensure()
    let res
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, referer, cookie, accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      lastError = new Error('网络请求失败：' + (error && error.message ? error.message : String(error)))
      await sleep(400 * (attempt + 1))
      continue
    }
    if (res.status === 412 || res.status === 403) {
      lastError = new Error('B 站风控拦截（HTTP ' + res.status + '）')
      await jar.reset()
      await sleep(300 * (attempt + 1))
      continue
    }
    if (!res.ok) {
      lastError = new Error('B 站接口 HTTP ' + res.status)
      await sleep(250 * (attempt + 1))
      continue
    }
    const data = await res.json().catch(() => null)
    if (!data) {
      lastError = new Error('B 站接口返回了无法解析的内容')
      continue
    }
    if (data.code === -412) {
      lastError = new Error('B 站风控拦截（code -412）')
      await jar.reset()
      await sleep(300 * (attempt + 1))
      continue
    }
    return data
  }
  throw lastError || new Error('B 站接口请求失败')
}

/** HTML 实体与高亮标签清理。 */
export function plainText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "3:45" / "1:02:03" → 秒。 */
export function parseDuration(value) {
  const parts = String(value || '').trim().split(':').map(Number)
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** 封面地址补全协议；只保留 B 站图床。 */
export function normalizeCover(pic) {
  const raw = String(pic || '').trim()
  if (!raw) return ''
  const url = raw.startsWith('//') ? 'https:' + raw : raw
  try {
    const host = new URL(url).hostname
    if (!/(^|\.)hdslb\.com$/i.test(host) && !/(^|\.)bilibili\.com$/i.test(host)) return ''
    return url
  } catch {
    return ''
  }
}

/**
 * 搜索视频。
 * @param {string} keyword 关键词
 * @param {{ page?: number, limit?: number }} [options]
 */
export async function searchVideos(keyword, options = {}) {
  const query = String(keyword || '').trim()
  if (!query) return []
  const page = Math.max(1, Math.min(10, Math.round(options.page || 1)))
  const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video'
    + '&keyword=' + encodeURIComponent(query) + '&page=' + page
  const data = await biliJson(url)
  if (data.code !== 0) throw new Error('搜索失败：' + (data.message || data.code))
  const list = Array.isArray(data.data && data.data.result) ? data.data.result : []
  const out = []
  for (const item of list) {
    const bvid = String(item.bvid || '').trim()
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) continue
    const seconds = parseDuration(item.duration)
    if (!seconds) continue
    out.push({
      bvid,
      title: plainText(item.title),
      author: plainText(item.author),
      duration: seconds,
      cover: normalizeCover(item.pic),
      play: Number(item.play) || 0,
      danmaku: Number(item.video_review) || 0,
      pubdate: Number(item.pubdate) || 0,
      description: plainText(item.description).slice(0, 120),
    })
    if (options.limit && out.length >= options.limit) break
  }
  return out
}

/**
 * 取视频基本信息（cid / 标题 / 作者 / 封面 / 时长）。
 * @param {string} bvid
 */
export async function videoInfo(bvid) {
  const data = await biliJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { referer: SITE_REFERER })
  if (data.code !== 0 || !data.data) throw new Error('取视频信息失败：' + (data.message || data.code))
  const info = data.data
  const pages = Array.isArray(info.pages) ? info.pages : []
  return {
    bvid,
    cid: Number(info.cid) || Number(pages[0] && pages[0].cid) || 0,
    title: plainText(info.title),
    author: plainText(info.owner && info.owner.name),
    cover: normalizeCover(info.pic),
    duration: Number(info.duration) || Number(pages[0] && pages[0].duration) || 0,
    desc: plainText(info.desc).slice(0, 200),
  }
}

/**
 * 取音频直链候选（DASH 音频流，按码率从高到低）。
 * @param {{ bvid: string, cid: number }} target
 */
export async function audioStreams(target) {
  const { bvid, cid } = target
  if (!bvid || !cid) throw new Error('缺少 bvid 或 cid')
  const url = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
    + '&cid=' + encodeURIComponent(cid) + '&fnval=4048&fnver=0&fourk=1'
  const data = await biliJson(url, { referer: SITE_REFERER })
  if (data.code !== 0 || !data.data) throw new Error('取播放地址失败：' + (data.message || data.code))
  const dash = data.data.dash
  const streams = []
  if (dash && Array.isArray(dash.audio)) {
    for (const item of dash.audio) {
      const baseUrl = String(item.baseUrl || item.base_url || '')
      if (!baseUrl) continue
      const backups = (Array.isArray(item.backupUrl) ? item.backupUrl : Array.isArray(item.backup_url) ? item.backup_url : [])
        .map(value => String(value || '')).filter(Boolean)
      streams.push({
        url: baseUrl,
        backups,
        bandwidth: Number(item.bandwidth) || 0,
        id: Number(item.id) || 0,
        codecs: String(item.codecs || ''),
        mime: String(item.mimeType || item.mime_type || ''),
      })
    }
    streams.sort((a, b) => b.bandwidth - a.bandwidth)
  }
  if (!streams.length) {
    // 老视频 / 番剧只有 durl：整段 mp4/flv，让 ffmpeg 抽音轨。
    const durl = data.data.durl
    if (Array.isArray(durl) && durl.length) {
      const first = durl[0]
      const value = String(first.url || '')
      if (value) streams.push({ url: value, backups: [], bandwidth: 0, id: 0, codecs: '', mime: 'video/mp4' })
    }
  }
  if (!streams.length) throw new Error('该视频没有可用音频流（可能是番剧或直播）')
  return streams
}

/**
 * 取视频直链候选（DASH 视频流）。
 *
 * 优先级：同清晰度里优先 avc1（浏览器/ffmpeg 都能吃），再按清晰度、码率从高到低。
 * B 站同一清晰度会同时给 avc1 / hvc1 / av01 三份，选错会让网页播不出来。
 * @param {{ bvid: string, cid: number }} target
 */
export async function videoStreams(target) {
  const { bvid, cid } = target
  if (!bvid || !cid) throw new Error('缺少 bvid 或 cid')
  const url = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
    + '&cid=' + encodeURIComponent(cid) + '&fnval=4048&fnver=0&fourk=1'
  const data = await biliJson(url, { referer: SITE_REFERER })
  if (data.code !== 0 || !data.data) throw new Error('取播放地址失败：' + (data.message || data.code))
  const dash = data.data.dash
  const candidates = []
  if (dash && Array.isArray(dash.video)) {
    for (const item of dash.video) {
      const baseUrl = String(item.baseUrl || item.base_url || '')
      if (!baseUrl) continue
      const backups = (Array.isArray(item.backupUrl) ? item.backupUrl : Array.isArray(item.backup_url) ? item.backup_url : [])
        .map(value => String(value || '')).filter(Boolean)
      const codecs = String(item.codecs || '')
      candidates.push({
        url: baseUrl,
        backups,
        quality: Number(item.id) || 0,
        codecs,
        avc: /^avc1/i.test(codecs),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        bandwidth: Number(item.bandwidth) || 0,
      })
    }
  }
  if (!candidates.length) throw new Error('该视频没有可用的 DASH 视频流（可能是番剧或直播）')
  candidates.sort((a, b) => {
    if (a.avc !== b.avc) return a.avc ? -1 : 1
    if (a.quality !== b.quality) return b.quality - a.quality
    return b.bandwidth - a.bandwidth
  })
  return candidates
}

/**
 * 下载音频流到本地文件，带进度回调与备用地址重试。
 * @param {Awaited<ReturnType<typeof audioStreams>>[number]} stream
 * @param {string} destPath
 * @param {{ onProgress?: (ratio: number, bytes: number) => void, signal?: AbortSignal }} [options]
 */
export async function downloadStream(stream, destPath, options = {}) {
  const candidates = [stream.url, ...(stream.backups || [])]
  let lastError
  for (const candidate of candidates) {
    try {
      return await downloadOne(candidate, destPath, options)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('音频下载失败')
}

async function downloadOne(url, destPath, options) {
  const cookie = await jar.ensure()
  // 空闲超时：连接被中间设备吞掉时不会报错也不会关，光靠外层没救。
  const controller = new AbortController()
  const abort = () => { try { controller.abort() } catch { /* 已经断了 */ } }
  const IDLE_MS = 45000
  let idle = setTimeout(abort, IDLE_MS)
  const pulse = () => { clearTimeout(idle); idle = setTimeout(abort, IDLE_MS) }
  const onOuterAbort = () => abort()
  if (options.signal) {
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: SITE_REFERER, cookie },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error('音频流 HTTP ' + res.status)
    const total = Number(res.headers.get('content-length')) || 0
    const handle = await (await import('node:fs/promises')).open(destPath, 'w')
    let written = 0
    let lastReport = 0
    try {
      for await (const chunk of res.body) {
        pulse()
        await handle.write(chunk)
        written += chunk.length
        const now = Date.now()
        if (options.onProgress && now - lastReport > 250) {
          lastReport = now
          options.onProgress(total ? written / total : 0, written)
        }
      }
    } finally {
      await handle.close()
    }
    if (options.onProgress) options.onProgress(1, written)
    if (!written) throw new Error('音频流为空')
    return written
  } catch (error) {
    if (controller.signal.aborted && !(options.signal && options.signal.aborted)) {
      throw new Error('下载卡住超过 ' + Math.round(IDLE_MS / 1000) + ' 秒，已放弃这一路')
    }
    throw error
  } finally {
    clearTimeout(idle)
    if (options.signal) options.signal.removeEventListener('abort', onOuterAbort)
  }
}
