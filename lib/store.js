/**
 * 曲库与设置持久化（Host 侧）。
 *
 * 目录结构：
 *   %USERPROFILE%\.dsh\music-player\
 *     library.json   曲库索引（曲目 + 歌单）
 *     settings.json  皮肤 / 音量 / 目录 / 排序 / 快捷键等
 *     tmp\           下载中转（m4s → mp3/mp4）
 *
 * 曲目分两类：kind = 'audio' | 'video'，两者共用同一套排序/筛选/歌单/检索逻辑。
 * 歌单是独立实体（playlists[].trackIds），一首歌可以同时在多个歌单里。
 */
import { existsSync, promises as fsp } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.weba'])
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.flv', '.webm', '.mov', '.avi', '.ts'])
const JIJI_CANDIDATES = [
  'D:\\Program Files\\JiJiDown',
  'C:\\Program Files\\JiJiDown',
  'C:\\Program Files (x86)\\JiJiDown',
  'D:\\JiJiDown',
  'C:\\JiJiDown',
  'E:\\JiJiDown',
]

/** 默认快捷键（可被设置覆盖）。combo 用 event.code 拼，修饰键顺序固定 Ctrl+Alt+Shift+Meta。 */
export const DEFAULT_SHORTCUTS = {
  global: {
    playPause: 'Ctrl+Shift+Space',
    next: 'Ctrl+Shift+ArrowRight',
    prev: 'Ctrl+Shift+ArrowLeft',
    volumeUp: 'Ctrl+Shift+ArrowUp',
    volumeDown: 'Ctrl+Shift+ArrowDown',
    mute: 'Ctrl+Shift+KeyM',
    togglePanel: 'Ctrl+Shift+KeyP',
    videoWindow: 'Ctrl+Shift+KeyV',
    fullscreen: 'Ctrl+Shift+KeyF',
  },
  panel: {
    playPause: 'Space',
    seekForward: 'ArrowRight',
    seekBack: 'ArrowLeft',
    volumeUp: 'ArrowUp',
    volumeDown: 'ArrowDown',
    mute: 'KeyM',
    close: 'Escape',
    fullscreen: 'KeyF',
  },
}

/** 找唧唧DOWN 的安装目录（只认存在 JiJiDownForWPF.exe 的目录）。 */
export function findJiJiDown() {
  for (const candidate of JIJI_CANDIDATES) {
    if (existsSync(path.join(candidate, 'JiJiDownForWPF.exe'))) return candidate
  }
  return ''
}

export function defaultPaths() {
  const jiji = findJiJiDown()
  // 媒体优先放 E 盘（大文件不挤系统盘）；没有 E: 就退回用户目录。
  const mediaHome = existsSync('E:\\') ? 'E:\\DshMusic' : path.join(os.homedir(), 'Music', 'DshMusic')
  return {
    downloadDir: mediaHome,
    jijidownDir: jiji ? path.join(jiji, 'Download') : '',
    jijidownHome: jiji,
    ffmpegPath: jiji ? path.join(jiji, 'OrderEXE', 'ffmpeg.exe') : '',
  }
}

export function defaultSettings() {
  const paths = defaultPaths()
  return {
    version: 2,
    downloadDir: paths.downloadDir,
    jijidownDir: paths.jijidownDir,
    ffmpegPath: paths.ffmpegPath,
    scanJijidown: Boolean(paths.jijidownDir),
    maxConcurrent: 2,
    volume: 0.75,
    muted: false,
    repeat: 'all',
    shuffle: false,
    sort: 'added',
    asc: false,
    category: '全部',
    kind: 'all',
    skin: {
      preset: 'deepsea',
      presetName: '',
      accent: '#54b8ff',
      surface: '#0b1422',
      text: '#e9f2ff',
      blur: 18,
      opacity: 0.82,
      radius: 18,
      glow: true,
      anim: true,
      gradient: '',
      bgFile: '',
      bgStamp: 0,
      bgDim: 0.35,
      bgBlur: 0,
    },
    shortcuts: DEFAULT_SHORTCUTS,
    autoVideoWindow: true,
    askMode: 'discover',
    askThink: true,
    // 点歌代理：每次点歌单开一个一次性会话（独立工作区、不读历史）。
    // askDir 留空时由 index.js 兜底成 <数据目录>/search。
    askFresh: true,
    askDir: '',
    askPreset: 'music',
    askProvider: 'deepseek-official',
    askModel: 'deepseek-flash',
    askEffort: 'low',
    askTimeoutMs: 150000,
    // 媒体整段读成 blob 的上限（MB）：越大越能保证拖动可用，但占内存/磁盘缓存。
    blobMaxMB: 256,
  }
}

/** 文件名 → 可读标题（兼容唧唧DOWN 的 "标题 - 1.标题(Av123,P1).mp3"）。 */
export function titleFromFile(fileName) {
  let name = String(fileName || '').replace(/\.[^.]+$/, '')
  name = name.replace(/\((?:Av|BV)[0-9A-Za-z]+(?:,P\d+)?\)/gi, '')
  // 唧唧的命名是「标题 - 1.标题」：取前一段就是真标题。
  name = name.replace(/\s*-\s*\d+\..*$/, '')
  name = name.replace(/^\d+\.\s*/, '')
  name = name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name || String(fileName || '未知曲目')
}

/** 从唧唧DOWN 文件名里抠 av 号。 */
export function avFromFile(fileName) {
  const match = /\((Av|BV)([0-9A-Za-z]+)/i.exec(String(fileName || ''))
  if (!match) return ''
  return match[1].toLowerCase() === 'av' ? 'av' + match[2] : 'BV' + match[2]
}

export function kindFromFile(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return ''
}

/** 文件名安全化（Windows 非法字符）。 */
export function safeName(value, fallback = 'track') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

function trackId(file) {
  return 't-' + createHash('sha1').update(String(file).toLowerCase()).digest('hex').slice(0, 12)
}

function slugName(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return text || fallback
}

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/')
}

/** 曲库 + 歌单 + 设置。所有写入都合并成一次落盘，避免频繁 IO。 */
export class MusicStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.tmpDir = path.join(dataDir, 'tmp')
    this.libraryFile = path.join(dataDir, 'library.json')
    this.settingsFile = path.join(dataDir, 'settings.json')
    this.tracks = new Map()
    this.playlists = []
    this.settings = defaultSettings()
    this.rev = 1
    this.saveTimer = null
    this.saving = Promise.resolve()
    this.byPath = new Map()
  }

  async load() {
    await fsp.mkdir(this.tmpDir, { recursive: true }).catch(() => {})
    // 上一次被强杀/热重载留下的下载临时片（.asrc/.vsrc）没有别的代码会清，启动即回收。
    try {
      const leftovers = await fsp.readdir(this.tmpDir)
      await Promise.all(leftovers
        .filter(name => /\.(asrc|vsrc)$/i.test(name))
        .map(name => fsp.unlink(path.join(this.tmpDir, name)).catch(() => {})))
    } catch { /* tmp 不存在/不可读不影响启动 */ }
    const readJson = async (file) => {
      try {
        return JSON.parse(await fsp.readFile(file, 'utf8'))
      } catch { return null }
    }
    const settings = await readJson(this.settingsFile)
    if (settings && typeof settings === 'object') {
      const base = defaultSettings()
      this.settings = {
        ...base,
        ...settings,
        skin: { ...base.skin, ...(settings.skin || {}) },
        shortcuts: {
          global: { ...base.shortcuts.global, ...((settings.shortcuts && settings.shortcuts.global) || {}) },
          panel: { ...base.shortcuts.panel, ...((settings.shortcuts && settings.shortcuts.panel) || {}) },
        },
      }
    }
    const library = await readJson(this.libraryFile)
    if (library && Array.isArray(library.tracks)) {
      for (const track of library.tracks) {
        if (!track || !track.file) continue
        const normalized = this.normalizeTrack(track)
        this.tracks.set(normalized.id, normalized)
        this.indexTrack(normalized)
      }
    }
    if (library && Array.isArray(library.playlists)) {
      for (const playlist of library.playlists) {
        if (!playlist || !playlist.id) continue
        this.playlists.push({
          id: String(playlist.id),
          name: slugName(playlist.name, '未命名歌单'),
          createdAt: Number(playlist.createdAt) || Date.now(),
          trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds.filter(id => this.tracks.has(id)) : [],
        })
      }
    }
    // 歌单里的死链、曲库里不存在的 id 顺手清掉
    for (const playlist of this.playlists) {
      playlist.trackIds = [...new Set(playlist.trackIds)].filter(id => this.tracks.has(id))
    }
  }

  normalizeTrack(track) {
    const file = normalizePath(track.file)
    const kind = track.kind === 'video' ? 'video' : (track.kind === 'audio' ? 'audio' : (kindFromFile(file) || 'audio'))
    return {
      id: track.id || trackId(file),
      file,
      name: path.basename(file),
      kind,
      title: String(track.title || titleFromFile(path.basename(file))),
      artist: String(track.artist || ''),
      duration: Number(track.duration) || 0,
      bv: String(track.bv || ''),
      av: String(track.av || avFromFile(path.basename(file))),
      cover: String(track.cover || ''),
      tags: Array.isArray(track.tags) ? track.tags.filter(Boolean).map(String).slice(0, 8) : [],
      category: String(track.category || '未分类'),
      source: String(track.source || 'local'),
      addedAt: Number(track.addedAt) || Date.now(),
      size: Number(track.size) || 0,
      plays: Number(track.plays) || 0,
      lastPlayedAt: Number(track.lastPlayedAt) || 0,
      fav: Boolean(track.fav),
      width: Number(track.width) || 0,
      height: Number(track.height) || 0,
    }
  }

  markDirty() {
    this.rev += 1
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 600)
  }

  async save() {
    const payload = {
      version: 2,
      tracks: [...this.tracks.values()],
      playlists: this.playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        createdAt: playlist.createdAt,
        trackIds: playlist.trackIds,
      })),
    }
    this.saving = this.saving
      .then(() => fsp.writeFile(this.libraryFile, JSON.stringify(payload), 'utf8'))
      .catch(() => {})
    await this.saving
    return true
  }

  async saveSettings() {
    try {
      await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch { /* 设置写失败不影响播放 */ }
  }

  list() {
    return [...this.tracks.values()]
  }

  get(id) {
    return this.tracks.get(id)
  }

  has(file) {
    return this.byPath.has(normalizePath(file).toLowerCase())
  }

  /** 维护「归一化小写路径 → 曲目 id」的索引，避免 has() 每次线性扫全库。 */
  indexTrack(track) {
    if (!track || !track.file) return
    this.byPath.set(track.file.toLowerCase(), track.id)
  }

  unindexTrack(track) {
    if (!track || !track.file) return
    this.byPath.delete(track.file.toLowerCase())
  }

  addTrack(input) {
    const file = normalizePath(input.file)
    const normalized = this.normalizeTrack({ ...input, file })
    const existing = this.tracks.get(normalized.id)
    if (existing) {
      // 文件相关字段跟着新文件走；用户手动维护的元数据（标签/分类/收藏/封面/播放次数）
      // 绝不能被「重下一次同一首」清成默认值——只在新值为空时才补。
      const merged = {
        ...existing,
        ...normalized,
        addedAt: existing.addedAt,
        plays: existing.plays,
        lastPlayedAt: existing.lastPlayedAt,
        size: normalized.size || existing.size,
        title: normalized.title || existing.title,
        artist: normalized.artist || existing.artist,
        tags: existing.tags.length ? existing.tags : normalized.tags,
        category: existing.category && existing.category !== '未分类' ? existing.category : normalized.category,
        fav: existing.fav || normalized.fav,
        cover: existing.cover || normalized.cover,
        bv: existing.bv || normalized.bv,
        duration: existing.duration || normalized.duration,
      }
      this.unindexTrack(existing)
      this.tracks.set(existing.id, merged)
      this.indexTrack(merged)
      this.markDirty()
      return merged
    }
    this.tracks.set(normalized.id, normalized)
    this.indexTrack(normalized)
    this.markDirty()
    return normalized
  }

  updateTrack(id, patch) {
    const track = this.tracks.get(id)
    if (!track) return null
    const allowed = ['title', 'artist', 'duration', 'cover', 'tags', 'category', 'fav', 'bv', 'av', 'plays', 'lastPlayedAt', 'width', 'height']
    for (const key of allowed) {
      if (!(key in patch)) continue
      if (key === 'tags') {
        track.tags = Array.isArray(patch.tags) ? patch.tags.filter(Boolean).map(String).slice(0, 8) : track.tags
      } else if (key === 'fav') {
        track.fav = Boolean(patch.fav)
      } else if (typeof track[key] === 'number') {
        track[key] = Number(patch[key]) || 0
      } else {
        track[key] = String(patch[key] == null ? '' : patch[key])
      }
    }
    this.markDirty()
    return track
  }

  async removeTrack(id, deleteFile = false) {
    const track = this.tracks.get(id)
    if (!track) return false
    if (deleteFile) {
      // 先删文件、后删索引：反过来（旧写法）文件删失败时索引已经没了，
      // 下次扫描会把它当新歌加回来，标签/收藏/播放次数全丢。
      try {
        await fsp.unlink(track.file)
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          const wrapped = new Error('文件正在被占用或没有权限删除：' + String((error && error.message) || error))
          wrapped.code = 'file_locked'
          throw wrapped
        }
      }
    }
    this.tracks.delete(id)
    this.unindexTrack(track)
    for (const playlist of this.playlists) {
      playlist.trackIds = playlist.trackIds.filter(trackId => trackId !== id)
    }
    this.markDirty()
    return true
  }

  async patchSettings(patch) {
    if (!patch || typeof patch !== 'object') return this.settings
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'skin' && value && typeof value === 'object') {
        this.settings.skin = { ...this.settings.skin, ...value }
        continue
      }
      if (key === 'shortcuts' && value && typeof value === 'object') {
        const base = this.settings.shortcuts
        this.settings.shortcuts = {
          global: { ...base.global, ...(value.global || {}) },
          panel: { ...base.panel, ...(value.panel || {}) },
        }
        continue
      }
      if (key === 'version') continue
      this.settings[key] = value
    }
    this.rev += 1
    await this.saveSettings()
    return this.settings
  }

  // ── 歌单 ────────────────────────────────────────────────────────────
  listPlaylists() {
    return this.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      createdAt: playlist.createdAt,
      count: playlist.trackIds.length,
      trackIds: playlist.trackIds,
    }))
  }

  getPlaylist(id) {
    return this.playlists.find(playlist => playlist.id === id)
  }

  /** 一首歌在哪些歌单里。 */
  playlistsOf(trackId) {
    return this.playlists.filter(playlist => playlist.trackIds.includes(trackId)).map(playlist => playlist.id)
  }

  createPlaylist(name) {
    const playlist = {
      id: 'p-' + randomUUID().slice(0, 8),
      name: slugName(name, '新歌单 ' + (this.playlists.length + 1)),
      createdAt: Date.now(),
      trackIds: [],
    }
    this.playlists.push(playlist)
    this.markDirty()
    return playlist
  }

  renamePlaylist(id, name) {
    const playlist = this.getPlaylist(id)
    if (!playlist) return null
    playlist.name = slugName(name, playlist.name)
    this.markDirty()
    return playlist
  }

  deletePlaylist(id) {
    const before = this.playlists.length
    this.playlists = this.playlists.filter(playlist => playlist.id !== id)
    if (this.playlists.length === before) return false
    this.markDirty()
    return true
  }

  /** 把若干首加进歌单（去重，保持加入顺序）。 */
  addToPlaylist(playlistId, trackIds) {
    const playlist = this.getPlaylist(playlistId)
    if (!playlist) return null
    const next = new Set(playlist.trackIds)
    let added = 0
    for (const id of trackIds) {
      if (!this.tracks.has(id) || next.has(id)) continue
      next.add(id)
      added += 1
    }
    playlist.trackIds = [...next]
    if (added) this.markDirty()
    return { added, count: playlist.trackIds.length }
  }

  removeFromPlaylist(playlistId, trackIds) {
    const playlist = this.getPlaylist(playlistId)
    if (!playlist) return null
    const drop = new Set(trackIds)
    const before = playlist.trackIds.length
    playlist.trackIds = playlist.trackIds.filter(id => !drop.has(id))
    const removed = before - playlist.trackIds.length
    if (removed) this.markDirty()
    return { removed, count: playlist.trackIds.length }
  }

  /** 某首歌的歌单归属整体重设（面板里勾选那种）。 */
  setTrackPlaylists(trackId, playlistIds) {
    if (!this.tracks.has(trackId)) return null
    const wanted = new Set(Array.isArray(playlistIds) ? playlistIds : [])
    for (const playlist of this.playlists) {
      const has = playlist.trackIds.includes(trackId)
      const want = wanted.has(playlist.id)
      if (has && !want) playlist.trackIds = playlist.trackIds.filter(id => id !== trackId)
      if (!has && want) playlist.trackIds = [...playlist.trackIds, trackId]
    }
    this.markDirty()
    return this.playlistsOf(trackId)
  }

  /** 批量：一次给多首歌加/减同一个歌单。 */
  bulkPlaylist(playlistId, trackIds, mode) {
    if (!this.getPlaylist(playlistId)) return null
    return mode === 'remove'
      ? this.removeFromPlaylist(playlistId, trackIds)
      : this.addToPlaylist(playlistId, trackIds)
  }

  /**
   * 把 fromDir 里的媒体文件整体挪到 toDir，并同步索引里的路径。
   * 跨盘 rename 会抛 EXDEV，退回「复制 + 删源」。
   * @returns {Promise<{ moved: number, failed: Array<{ file: string, reason: string }>, to: string }>}
   */
  async migrateDir(fromDir, toDir) {
    // 索引里的路径统一是正斜杠，比较时两边都归一化，否则永远匹配不上。
    const fromCmp = normalizePath(fromDir).toLowerCase()
    const toOs = path.resolve(String(toDir || ''))
    const toCmp = normalizePath(toOs).toLowerCase()
    const moved = []
    const failed = []
    await fsp.mkdir(toOs, { recursive: true }).catch(() => {})
    for (const track of [...this.tracks.values()]) {
      const fileCmp = track.file.toLowerCase()
      // 目录边界：from=E:\DshMusic 时不能把 E:\DshMusic-备份 里的文件也搬走
      if (fileCmp !== fromCmp && !fileCmp.startsWith(fromCmp + '/')) continue
      if (normalizePath(path.dirname(track.file)).toLowerCase() === toCmp) continue
      const dest = path.join(toOs, path.basename(track.file))
      try {
        if (dest.toLowerCase() === track.file.toLowerCase()) continue
        if (existsSync(dest)) { failed.push({ file: path.basename(track.file), reason: '目标已存在同名文件' }); continue }
        try {
          await fsp.rename(track.file, dest)
        } catch (error) {
          if (error && error.code === 'EXDEV') {
            await fsp.copyFile(track.file, dest)
            await fsp.unlink(track.file)
          } else {
            throw error
          }
        }
        this.unindexTrack(track)
        track.file = normalizePath(dest)
        track.name = path.basename(dest)
        this.indexTrack(track)
        moved.push(track.id)
        // 每 20 首落一次盘：中途磁盘满/权限拒绝时，重启后索引与磁盘不会南辕北辙。
        if (moved.length % 20 === 0) await this.save()
      } catch (error) {
        failed.push({ file: path.basename(track.file), reason: String((error && error.message) || error).slice(0, 120) })
      }
    }
    if (moved.length) {
      this.settings.downloadDir = toOs
      this.markDirty()
      await this.save()
      await this.saveSettings()
    }
    return { moved: moved.length, failed, to: toOs }
  }

  /** 扫目录入库：只收音频/视频扩展名，未知文件跳过。 */
  async scanDirs(dirs, options = {}) {
    const source = options.source || 'local'
    const added = []
    const seen = new Set()
    for (const dir of dirs) {
      if (!dir) continue
      let entries = []
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const kind = kindFromFile(entry.name)
        if (!kind) continue
        const file = path.join(dir, entry.name)
        const key = normalizePath(file).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        if (this.has(file)) continue
        let size = 0
        try { size = (await fsp.stat(file)).size } catch { continue }
        if (!size) continue
        const track = this.addTrack({
          file,
          kind,
          title: titleFromFile(entry.name),
          artist: '',
          av: avFromFile(entry.name),
          source,
          size,
          addedAt: Date.now(),
          category: source === 'jijidown' ? '唧唧Download' : '未分类',
        })
        added.push(track)
      }
    }
    return added
  }
}
