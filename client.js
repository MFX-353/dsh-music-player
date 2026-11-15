/**
 * dsh-music-player —— 网页半端
 *
 * 三个座位：
 *   conversation.header.leading  顶部迷你播放器（常驻）
 *   shell.overlay                悬浮面板（曲库 / 搜索 / 点歌 / 外观 / 按键）
 *   shell.overlay                视频窗口（可拖拽可缩放，音频曲目时显示提示）
 *
 * 约束：
 *  · 音频元素与视频元素都是模块级单例，面板关掉照样出声/出画面；
 *  · 动画只在面板或视频窗可见、且页面可见时跑；
 *  · 页面隐藏就不发请求；关着面板时轮询降到 6 秒。
 */
window.__ModuleLoader__.load({
  id: 'dsh-music-player',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-music/api'
    const CLIENT_BUILD = 'v31'

    // ── 小工具 ────────────────────────────────────────────────────────
    const fmtTime = (seconds, precise) => {
      const total = Math.max(0, Number(seconds) || 0)
      const hh = Math.floor(total / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      const pad = (value) => String(Math.floor(value)).padStart(2, '0')
      if (hh > 0) return hh + ':' + pad(mm) + ':' + pad(ss)
      // 很短的片子（不到 10 秒）带上一位小数，否则 0:00 / 0:00 看着像坏了
      if (precise) return mm + ':' + ss.toFixed(1).padStart(4, '0')
      return mm + ':' + pad(ss)
    }
    const cx = (...parts) => parts.filter(Boolean).join(' ')

    /** 把用户选的图缩到 1600px 以内再交给宿主，省得 settings 目录里堆几十兆原图。 */
    const downscaleImage = (file, maxWidth, quality) => new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('读不了这个文件'))
      reader.onload = () => {
        const img = new Image()
        img.onerror = () => reject(new Error('不是有效的图片'))
        img.onload = () => {
          try {
            const scale = Math.min(1, maxWidth / (img.width || maxWidth))
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round((img.width || maxWidth) * scale))
            canvas.height = Math.max(1, Math.round((img.height || maxWidth) * scale))
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
            const keepPng = /png/i.test(file.type) && file.size < 900 * 1024
            resolve(canvas.toDataURL(keepPng ? 'image/png' : 'image/jpeg', quality))
          } catch (error) {
            reject(new Error('处理图片失败：' + (error && error.message)))
          }
        }
        img.src = String(reader.result)
      }
      reader.readAsDataURL(file)
    })

    // 宿主只认带这个自定义头的写请求（防跨站网页改设置）；GET 也带上，便于宿主统一识别。
    const CLIENT_HEADERS = { 'x-dsh-music-client': '1' }

    async function getJson(url, options = {}) {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...CLIENT_HEADERS },
        signal: options.signal,
      })
      if (res.status === 304) return null
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error((data && data.error && data.error.message) || 'HTTP ' + res.status)
      }
      return res.json()
    }
    async function postJson(url, body, options = {}) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
        body: JSON.stringify(body || {}),
        signal: options.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && data.error && data.error.message) || 'HTTP ' + res.status)
      return data
    }

    // ── 皮肤 ──────────────────────────────────────────────────────────
    const SKIN_PRESETS = {
      deepsea: { label: '深海鲸蓝', accent: '#54b8ff', surface: '#0b1422', text: '#e9f2ff' },
      midnight: { label: '午夜黑', accent: '#8ab4f8', surface: '#101318', text: '#e8eaed' },
      sakura: { label: '樱花粉', accent: '#ff7eb6', surface: '#1d1420', text: '#ffeaf3' },
      cyber: { label: '赛博霓虹', accent: '#22e0c8', surface: '#0a0f14', text: '#d8fff8' },
      forest: { label: '松林绿', accent: '#7ec46b', surface: '#0f1712', text: '#e6f5e1' },
      paper: { label: '纸白', accent: '#2b6cb0', surface: '#f4f1ea', text: '#1f2328' },
    }
    const DEFAULT_SKIN = {
      preset: 'deepsea',
      presetName: '',
      accent: SKIN_PRESETS.deepsea.accent,
      surface: SKIN_PRESETS.deepsea.surface,
      text: SKIN_PRESETS.deepsea.text,
      blur: 18,
      opacity: 0.86,
      radius: 18,
      glow: true,
      anim: true,
      gradient: '',
      bgFile: '',
      bgStamp: 0,
      bgDim: 0.35,
      bgBlur: 0,
    }
    const DEFAULT_SETTINGS = {
      skin: DEFAULT_SKIN,
      volume: 0.75,
      sort: 'added',
      asc: false,
      kind: 'all',
      scanJijidown: true,
      autoVideoWindow: true,
      askMode: 'discover',
      askThink: true,
      shortcuts: { global: {}, panel: {} },
    }

    const SORT_OPTIONS = [
      { key: 'added', label: '最近添加' },
      { key: 'title', label: '标题' },
      { key: 'artist', label: 'UP 主' },
      { key: 'duration', label: '时长' },
      { key: 'plays', label: '播放次数' },
      { key: 'recent', label: '最近播放' },
    ]
    const KIND_OPTIONS = [
      { key: 'all', label: '全部' },
      { key: 'audio', label: '音频' },
      { key: 'video', label: '视频' },
    ]
    const ASK_MODES = [
      { key: 'discover', label: '找新歌', hint: '去 B 站检索、挑歌、下载入库' },
      { key: 'organize', label: '整理曲库', hint: '看现有曲目，建歌单分类，不下载' },
      { key: 'recommend', label: '播给我听', hint: '从曲库里挑几首直接放' },
    ]
    const PROMPT_CHIPS = {
      discover: [
        { label: '日语 · 节奏感', text: '帮我整理一批比较富有节奏感的日语歌曲，下载到曲库' },
        { label: '华语 · 古风', text: '给我来几首华语古风/国风的歌，下到曲库' },
        { label: '电音蹦迪', text: '我要电音、蹦迪那种能炸起来的歌，来 6 首' },
        { label: '燃系 ACG', text: '找一些燃系的 ACG 片头曲，下载下来' },
        { label: '鸡哥鬼畜', text: '我想听鸡哥的歌：蔡徐坤的鬼畜改编 + 他本人唱的，各来几首' },
        { label: '视频 · 鬼畜合集', text: '给我下几个好看的鬼畜视频，当视频存进曲库' },
      ],
      organize: [
        { label: '按语种分', text: '把曲库按语种整理成歌单' },
        { label: '按曲风分', text: '按曲风把歌分开建歌单' },
        { label: '挑出节奏感强的', text: '把节奏感强的挑出来单独建一个歌单' },
        { label: '清理垃圾', text: '看一遍曲库，把重复或明显不合适的挑出来，报给我' },
      ],
      recommend: [
        { label: '随便来一首', text: '从曲库里随便放一首' },
        { label: '要嗨的', text: '放点能嗨起来的' },
        { label: '安静的', text: '放首安静的，我要写代码' },
        { label: '放视频', text: '放个视频看看' },
      ],
    }

    // ── 状态仓库 ──────────────────────────────────────────────────────
    const storeListeners = new Set()
    let snapshot = { rev: -1, ready: false, settings: DEFAULT_SETTINGS, tracks: [], playlists: [], jobs: [], paths: {}, error: '' }
    const getSnapshot = () => snapshot
    const setSnapshot = (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of storeListeners) listener()
    }
    const subscribe = (listener) => {
      storeListeners.add(listener)
      return () => { storeListeners.delete(listener) }
    }
    const useStore = () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

    const playerListeners = new Set()
    let player = {
      trackId: '',
      kind: 'audio',
      playing: false,
      position: 0,
      duration: 0,
      volume: 0.75,
      muted: false,
      queue: [],
      index: -1,
      repeat: 'all',
      shuffle: false,
      error: '',
      // 大文件走 HTTP 流式播放（不做 blob），面板上会提示「拖动可能不准」
      streaming: false,
    }
    const getPlayer = () => player
    const setPlayer = (patch) => {
      player = { ...player, ...patch }
      for (const listener of playerListeners) listener()
    }
    const subscribePlayer = (listener) => {
      playerListeners.add(listener)
      return () => { playerListeners.delete(listener) }
    }
    const usePlayer = () => React.useSyncExternalStore(subscribePlayer, getPlayer, getPlayer)

    const uiListeners = new Set()
    let ui = {
      panelOpen: false,
      videoOpen: false,
      visible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
      recording: null,
    }
    const getUi = () => ui
    const setUi = (patch) => {
      ui = { ...ui, ...patch }
      for (const listener of uiListeners) listener()
    }
    const subscribeUi = (listener) => {
      uiListeners.add(listener)
      return () => { uiListeners.delete(listener) }
    }
    const useUi = () => React.useSyncExternalStore(subscribeUi, getUi, getUi)

    let clientCtx = null
    const beacon = (phase, extra) => {
      void postJson(API + '/playback', { clientPhase: phase, clientBuild: CLIENT_BUILD, ...(extra || {}) }).catch(() => {})
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }
      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error) }
      }
      componentDidCatch(error) {
        console.error('[dsh-music-player] 渲染失败', error)
        beacon('render-error', { clientError: String((error && error.message) || error).slice(0, 300) })
      }
      render() {
        if (this.state.error) {
          if (this.props.fallback === 'mini') return h('span', null, '♪')
          // 别静默返回 null（用户只看到播放器凭空消失）：给个能点重试的条子。
          return h('div', {
            style: {
              position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
              zIndex: 200, padding: '10px 14px', borderRadius: '10px',
              background: 'rgba(20,28,40,.94)', color: '#ffd0d0', fontSize: '12px',
              border: '1px solid rgba(255,107,107,.5)',
            },
          },
            '播放器渲染出错了：', String(this.state.error && this.state.error.message || this.state.error).slice(0, 120),
            h('button', {
              type: 'button',
              style: { marginLeft: '8px', padding: '2px 8px', borderRadius: '6px', cursor: 'pointer' },
              onClick: () => this.setState({ error: null }),
            }, '重试'),
          )
        }
        return this.props.children
      }
    }

    // ── 媒体元素（音频 + 视频，模块级单例） ────────────────────────────
    /** 进度条统一构造：时长未知时禁用并停在 0，避免"一拖就回到开头"。 */
    const progressBar = (position, duration, onSeek) => {
      const dur = duration > 0 ? duration : 0
      const pos = Math.max(0, Math.min(dur > 0 ? dur : 0, Number(position) || 0))
      return h('input', {
        className: 'mp-bar',
        type: 'range',
        min: 0,
        max: dur > 0 ? dur : 1,
        step: dur > 120 ? 1 : dur > 20 ? 0.5 : 0.1,
        value: pos,
        disabled: dur <= 0,
        'aria-label': '播放进度',
        'aria-valuetext': fmtTime(pos, true) + ' / ' + (dur > 0 ? fmtTime(dur, true) : '未知'),
        title: dur > 0 ? '' : '等媒体读了时长才能拖',
        style: { '--mp-pct': (dur > 0 ? Math.min(100, (pos / dur) * 100) : 0) + '%' },
        onChange: (event) => onSeek(Number(event.target.value)),
      })
    }

    let audioEl = null
    let videoEl = null
    let playReportTimer = 0
    let volumeReportTimer = 0
    let progressTimer = 0
    let lastSeekAt = 0
    let lastSeekNearEnd = false
    // 元数据还没到时签的 seek 会被浏览器丢掉（表现就是"拖了却从头放"），先记下来等 loadedmetadata
    const pendingSeek = { at: 0, target: 0 }

    const applyPendingSeek = (el, duration) => {
      if (!pendingSeek.at) return false
      const fresh = Date.now() - pendingSeek.at < 15000
      const target = pendingSeek.target
      pendingSeek.at = 0
      if (!fresh) return false
      const ceiling = duration > 0.3 ? duration - 0.12 : duration
      const clamped = duration > 0 ? Math.max(0, Math.min(ceiling, target)) : Math.max(0, target)
      try { el.currentTime = clamped } catch { return false }
      setPosition(clamped)
      setPlayer({ position: clamped })
      return true
    }

    const startProgressReporting = () => {
      if (progressTimer) return
      progressTimer = window.setInterval(() => {
        if (player.playing && ui.visible) reportPlayback()
      }, 20000)
    }
    const stopProgressReporting = () => {
      if (progressTimer) { window.clearInterval(progressTimer); progressTimer = 0 }
    }

    // 系统媒体键 / 耳机线控：Chromium 的 MediaSession API。旧版只写了「媒体键始终可用」，
    // 实际一个 handler 都没挂，按线控毫无反应。
    const setupMediaSession = () => {
      try {
        if (!('mediaSession' in navigator)) return
        navigator.mediaSession.setActionHandler('play', () => resume())
        navigator.mediaSession.setActionHandler('pause', () => pause())
        navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
        navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
        navigator.mediaSession.setActionHandler('seekbackward', () => seek(getPosition() - 10))
        navigator.mediaSession.setActionHandler('seekforward', () => seek(getPosition() + 10))
        navigator.mediaSession.setActionHandler('stop', () => pause())
      } catch { /* 浏览器不支持就算了 */ }
    }

    const reportPlayback = () => {
      void postJson(API + '/playback', {
        playing: player.playing,
        trackId: player.trackId,
        kind: player.kind,
        position: getPosition(),
        duration: player.duration,
        volume: player.volume,
        repeat: player.repeat,
        shuffle: player.shuffle,
        queue: player.queue.slice(0, 300),
        videoOpen: ui.videoOpen ? 1 : 0,
        clientBuild: CLIENT_BUILD,
      }).catch(() => {})
    }
    const scheduleReport = () => {
      if (playReportTimer) return
      playReportTimer = window.setTimeout(() => { playReportTimer = 0; reportPlayback() }, 700)
    }
    const scheduleVolumeSave = () => {
      if (volumeReportTimer) return
      volumeReportTimer = window.setTimeout(() => {
        volumeReportTimer = 0
        void postJson(API + '/settings', { patch: { volume: player.volume } }).catch(() => {})
        reportPlayback()
      }, 900)
    }

    const bindMedia = (el, kind) => {
      const active = () => player.kind === kind && mediaEl() === el
      let lastSyncedAt = 0
      el.addEventListener('timeupdate', () => {
        if (!active()) return
        const value = el.currentTime || 0
        setPosition(value)
        // player.position 只给上报/恢复用，2 秒同步一次足够，别让它带动整树渲染。
        const now = Date.now()
        if (now - lastSyncedAt > 2000) {
          lastSyncedAt = now
          setPlayer({ position: value })
        }
      })
      el.addEventListener('loadedmetadata', () => {
        if (!active()) return
        const duration = Number(el.duration) || 0
        setPlayer({ duration })
        applyPendingSeek(el, duration)
        const track = trackById(player.trackId)
        if (track && !track.duration && duration > 0) {
          void postJson(API + '/track', { action: 'setDuration', id: track.id, duration }).catch(() => {})
        }
      })
      el.addEventListener('play', () => {
        if (!active()) return
        setPlayer({ playing: true })
        scheduleReport()
        startProgressReporting()
      })
      el.addEventListener('pause', () => {
        if (!active()) return
        setPlayer({ playing: false })
        scheduleReport()
        stopProgressReporting()
      })
      el.addEventListener('ended', () => { if (active()) handleEnded() })
      el.addEventListener('error', () => {
        if (!active()) return
        setPlayer({ playing: false, error: '这个文件放不出来（可能被移走了）' })
      })
      return el
    }
    const ensureParkedHost = () => {
      if (parkedHost && parkedHost.isConnected) return parkedHost
      parkedHost = document.createElement('div')
      parkedHost.setAttribute('data-dsh-music-parked', '')
      parkedHost.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;'
      document.body.appendChild(parkedHost)
      return parkedHost
    }
    const park = (el) => {
      if (!el) return
      const host = ensureParkedHost()
      if (el.parentNode !== host) host.appendChild(el)
    }
    const parkVideo = () => park(videoEl)

    /**
     * 音频元素从不进可视区，但必须留在文档里：
     * 脱离文档的媒体元素在 Chromium 里 seekable 会塌成 [0,0]，拖动进度条只会回到开头。
     */
    const ensureAudio = () => {
      if (audioEl) return audioEl
      audioEl = bindMedia(document.createElement('audio'), 'audio')
      audioEl.preload = 'auto'
      audioEl.volume = player.volume
      park(audioEl)
      return audioEl
    }
    const ensureVideo = () => {
      if (videoEl) return videoEl
      videoEl = bindMedia(document.createElement('video'), 'video')
      videoEl.preload = 'auto'
      videoEl.volume = player.volume
      videoEl.playsInline = true
      videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;'
      parkVideo()
      return videoEl
    }
    const mediaEl = () => (player.kind === 'video' ? videoEl : audioEl)

    /**
     * 音频/视频元素都必须留在文档里：脱离文档的媒体元素在 Chromium 里 seekable 会塌成 [0,0]，
     * 进度条一拖就只能回到开头（看着像"重播"）。统一停在一个 0 号隐藏容器里。
     */
    let parkedHost = null

    /**
     * 当前媒体的真实时长。
     * 媒体元素自己的 duration 最准；它还没就绪时才回落到状态里的值（可能是上一首留下的）。
     */
    const mediaDuration = () => {
      const el = mediaEl()
      const real = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
      if (real) return real
      const cached = Number(player.duration) || 0
      return cached > 0 ? cached : 0
    }

    const trackById = (id) => snapshot.tracks.find(item => item.id === id)
    // 复用同一个 collator：localeCompare(…, 'zh') 每次比较都要现造 ICU 规则，是排序里最贵的一段。
    const zhCollator = typeof Intl !== 'undefined' && Intl.Collator ? new Intl.Collator('zh', { numeric: true, sensitivity: 'base' }) : null
    const compareText = (a, b) => (zhCollator ? zhCollator.compare(String(a), String(b)) : String(a).localeCompare(String(b)))
    const sortTracks = (tracks, settings) => {
      const key = (settings && settings.sort) || 'added'
      const asc = Boolean(settings && settings.asc)
      const list = tracks.slice()
      list.sort((a, b) => {
        let result
        if (key === 'title') result = compareText(a.title, b.title)
        else if (key === 'artist') result = compareText(a.artist || '~', b.artist || '~')
        else if (key === 'duration') result = (a.duration || 0) - (b.duration || 0)
        else if (key === 'plays') result = (a.plays || 0) - (b.plays || 0)
        else if (key === 'recent') result = (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0)
        else result = (a.addedAt || 0) - (b.addedAt || 0)
        return asc ? result : -result
      })
      return list
    }
    const mediaUrlOf = (track) => track.mediaUrl || ('/dsh-music/media/' + encodeURIComponent(track.id))

    /**
     * 媒体源：默认整段取成 blob URL。
     * blob 等于「已经下完的完整资源」，`seekable` 必定等于全长，拖进度条不会回开头。
     * 阈值可配（settings.blobMaxMB，默认 256）：Chromium 的大 blob 会落盘，不再全吃内存；
     * 超过阈值退回 HTTP 流式（宿主支持 206 段式，但超大文件是否可拖交给浏览器），
     * 面板会显示「流式」提示。
     */
    const blobUrls = new Map()
    let loadToken = 0
    let loadedTrackId = ''
    const blobLimitBytes = () => {
      const configured = Number(snapshot.settings && snapshot.settings.blobMaxMB)
      const mb = Number.isFinite(configured) && configured > 0 ? configured : 256
      return Math.min(2048, Math.max(8, mb)) * 1024 * 1024
    }
    const revokeAllBlobs = () => {
      for (const url of blobUrls.values()) {
        try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      }
      blobUrls.clear()
    }
    const srcFor = async (track) => {
      const cached = blobUrls.get(track.id)
      if (cached) return cached
      const size = Number(track.size) || 0
      if (size > blobLimitBytes()) {
        setPlayer({ streaming: true })
        return mediaUrlOf(track)
      }
      setPlayer({ streaming: false })
      const res = await fetch(mediaUrlOf(track))
      if (!res.ok) throw new Error('媒体读取失败 HTTP ' + res.status)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      blobUrls.set(track.id, url)
      if (blobUrls.size > 3) {
        const oldest = blobUrls.keys().next().value
        if (oldest && oldest !== track.id) {
          try { URL.revokeObjectURL(blobUrls.get(oldest)) } catch { /* ignore */ }
          blobUrls.delete(oldest)
        }
      }
      return url
    }

    /** 装载某首曲子的媒体源并起播（异步：blob 要等一下）。 */
    const loadAndPlay = (track, el) => {
      const token = ++loadToken
      void (async () => {
        let src = ''
        try {
          src = await srcFor(track)
        } catch (error) {
          setPlayer({ playing: false, error: '读不到媒体：' + (error && error.message ? error.message : error) })
          return
        }
        if (token !== loadToken || player.trackId !== track.id) return
        loadedTrackId = track.id
        el.src = src
        const attempt = el.play()
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => setPlayer({ playing: false }))
      })()
    }

    const playTrack = (trackOrId, queueIds) => {
      const track = typeof trackOrId === 'string' ? trackById(trackOrId) : trackOrId
      if (!track) return
      const kind = track.kind === 'video' ? 'video' : 'audio'
      pendingSeek.at = 0
      setPosition(0)
      const other = kind === 'video' ? audioEl : videoEl
      if (other) { try { other.pause() } catch { /* ignore */ } }
      const el = kind === 'video' ? ensureVideo() : ensureAudio()
      const queue = Array.isArray(queueIds) && queueIds.length
        ? queueIds
        : (player.queue.length ? player.queue : snapshot.tracks.map(item => item.id))
      setPlayer({
        trackId: track.id,
        kind,
        index: Math.max(0, queue.indexOf(track.id)),
        queue,
        position: 0,
        duration: track.duration || 0,
        error: '',
      })
      // 视频起播按设置自动开视频窗；切回音频就把视频窗收掉（不只是挂在那里显示提示）
      if (kind === 'video') {
        if (snapshot.settings.autoVideoWindow) setVideoOpen(true)
      } else if (ui.videoOpen) {
        setVideoOpen(false)
      }
      loadAndPlay(track, el)
      void postJson(API + '/track', { action: 'play', id: track.id }).catch(() => {})
      scheduleReport()
    }

    const resume = () => {
      if (!player.trackId) {
        const ordered = sortTracks(snapshot.tracks, snapshot.settings)
        if (ordered.length) playTrack(ordered[0], ordered.map(item => item.id))
        return
      }
      let el = mediaEl()
      if (!el) el = player.kind === 'video' ? ensureVideo() : ensureAudio()
      const track = trackById(player.trackId)
      if (!track) return
      // 源还没装好（或装的是别的曲子）：重新装一次，别拿空 src 去 play
      if (loadedTrackId !== track.id || !el.src) { loadAndPlay(track, el); return }
      const attempt = el.play()
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => setPlayer({ playing: false }))
      if (player.kind === 'video' && snapshot.settings.autoVideoWindow) setVideoOpen(true)
    }
    const pause = () => {
      const el = mediaEl()
      if (el) el.pause()
    }
    const setVideoOpen = (open) => {
      setUi({ videoOpen: Boolean(open) })
      scheduleReport()
    }

    // 视频窗根节点（快捷键要用它进全屏）与全屏开关
    let videoRootEl = null
    const toggleVideoFullscreen = () => {
      const el = videoRootEl
      if (!el) { setVideoOpen(true); return }
      try {
        if (document.fullscreenElement) { void document.exitFullscreen(); return }
        const attempt = el.requestFullscreen ? el.requestFullscreen() : null
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
      } catch { /* 不允许就算了 */ }
    }
    const toggle = () => {
      if (!player.trackId) { resume(); return }
      if (player.playing) pause()
      else resume()
    }
    const step = (delta) => {
      const queue = player.queue.length ? player.queue : snapshot.tracks.map(item => item.id)
      if (!queue.length) return
      let nextIndex = player.index + delta
      if (player.shuffle && queue.length > 1) {
        do { nextIndex = Math.floor(Math.random() * queue.length) } while (nextIndex === player.index)
      }
      if (nextIndex < 0) nextIndex = player.repeat === 'all' ? queue.length - 1 : 0
      if (nextIndex >= queue.length) nextIndex = player.repeat === 'all' ? 0 : queue.length - 1
      const target = trackById(queue[nextIndex])
      if (target) playTrack(target, queue)
    }
    const handleEnded = () => {
      // 刚拖过进度条（而且不是拖到末尾）时浏览器偶尔会补一个 ended，别拿它去切歌
      if (!lastSeekNearEnd && Date.now() - lastSeekAt < 250) return
      const el = mediaEl()
      if (player.repeat === 'one' && el) {
        el.currentTime = 0
        void el.play().catch(() => {})
        return
      }
      const queue = player.queue.length ? player.queue : snapshot.tracks.map(item => item.id)
      if (player.index >= queue.length - 1 && player.repeat === 'off' && !player.shuffle) {
        setPlayer({ playing: false })
        return
      }
      step(1)
    }
    // ── 播放位置：独立小 store ─────────────────────────────────────────
    // timeupdate 每秒来 4 次。塞进 player 的话，整个面板（曲库列表、页签、按钮）
    // 每次都跟着重渲染；位置单独订阅，只让进度条和时间两撮重画。
    let positionValue = 0
    const positionListeners = new Set()
    const subscribePosition = (listener) => {
      positionListeners.add(listener)
      return () => { positionListeners.delete(listener) }
    }
    const getPosition = () => positionValue
    function usePosition() {
      return React.useSyncExternalStore(subscribePosition, getPosition, getPosition)
    }
    const setPosition = (value) => {
      const next = Math.max(0, Number(value) || 0)
      if (Math.abs(next - positionValue) < 0.05) return
      positionValue = next
      for (const listener of positionListeners) listener()
    }
    const seek = (seconds) => {
      const el = mediaEl()
      if (!el) return
      const raw = Number(seconds)
      if (!Number.isFinite(raw)) return
      const dur = mediaDuration()
      // 时长未知时别夹到 0——那等于把视频拽回开头（拖动进度条会"重播"的元凶）
      // 时长已知时也不许拖到绝对的最后一帧：短片上那会立刻触发 ended，看起来就是"重播"
      const ceiling = dur > 0.3 ? dur - 0.12 : dur
      const target = dur > 0 ? Math.max(0, Math.min(ceiling, raw)) : Math.max(0, raw)
      lastSeekAt = Date.now()
      lastSeekNearEnd = dur > 0 && target >= dur - 0.4
      // 还没 loadingmetadata：先记账，等元数据到了再跳，别让浏览器把这次赋值当没发生
      if (el.readyState === 0) {
        pendingSeek.at = Date.now()
        pendingSeek.target = target
        setPosition(target)
        setPlayer({ position: target })
        scheduleReport()
        return
      }
      el.currentTime = target
      setPosition(target)
      setPlayer({ position: target })
      scheduleReport()
    }
    const setVolume = (value, persist = true) => {
      const volume = Math.max(0, Math.min(1, Number(value) || 0))
      if (audioEl) audioEl.volume = volume
      if (videoEl) videoEl.volume = volume
      if (persist) volumeRestored = true
      if (volume > 0.001) lastAudibleVolume = volume
      setPlayer({ volume, muted: volume === 0 })
      if (persist) scheduleVolumeSave()
    }
    // 静音前记住原来的音量：旧写法取消静音一律回到 60%，用户调好的音量白调。
    let lastAudibleVolume = 0.6
    const toggleMute = () => {
      if (player.muted || player.volume <= 0.001) setVolume(lastAudibleVolume || 0.6)
      else setVolume(0)
    }

    // ── 与 Host 同步 ─────────────────────────────────────────────────
    let syncPromise = null
    let volumeRestored = false
    let firstSyncDone = false
    // 已执行过的遥控命令 id：ack 丢了的时候 Host 会把同一条再投一次，靠它去重。
    const appliedCommandIds = new Set()
    const pendingAckIds = new Set()
    const flushAcks = () => {
      if (!pendingAckIds.size) return
      const ids = [...pendingAckIds]
      pendingAckIds.clear()
      void postJson(API + '/command-ack', { ids }).catch(() => {
        // ack 失败就把 id 放回去，下一轮再报；appliedCommandIds 保证不会重复执行。
        for (const id of ids) pendingAckIds.add(id)
      })
    }
    const syncState = () => {
      // 并发调用复用同一个请求：旧写法直接 return，操作完的刷新会被静默吃掉。
      if (syncPromise) return syncPromise
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 8000)
      syncPromise = (async () => {
        try {
          // 不带 rev：遥控命令靠这份状态投递，304 会把命令吃掉；整包几 KB，不值得为它冒险。
          const data = await getJson(API + '/state', { signal: controller.signal })
          if (!data) return
          const tracks = (data.tracks || []).map(track => ({ ...track, tags: Array.isArray(track.tags) ? track.tags : [], coverUrl: track.coverUrl || '' }))
          if (data.rev === snapshot.rev && !(data.commands || []).length) {
            // 内容和上次一模一样：别再产出一份新快照，省掉整树重渲染。
            flushAcks()
            return
          }
          setSnapshot({
            rev: data.rev,
            ready: true,
            settings: { ...snapshot.settings, ...(data.settings || {}) },
            tracks,
            playlists: data.playlists || [],
            jobs: data.jobs || [],
            paths: data.paths || {},
            error: '',
          })
          applyCommands(data.commands || [])
          flushAcks()
          if (!volumeRestored && data.settings && Number.isFinite(Number(data.settings.volume))) {
            volumeRestored = true
            setVolume(Number(data.settings.volume), false)
          }
          if (data.playback && !player.trackId && data.playback.trackId) {
            const restored = tracks.find(track => track.id === data.playback.trackId)
            if (restored) {
              setPlayer({
                trackId: restored.id,
                kind: restored.kind === 'video' ? 'video' : 'audio',
                position: Number(data.playback.position) || 0,
                volume: Number(data.playback.volume) || player.volume,
                repeat: data.playback.repeat || player.repeat,
                shuffle: Boolean(data.playback.shuffle),
                queue: Array.isArray(data.playback.queue) ? data.playback.queue : [],
                duration: restored.duration || 0,
              })
            }
          }
          if (!firstSyncDone) {
            firstSyncDone = true
            reportPlayback()
          }
        } catch (error) {
          const message = String((error && error.message) || error)
          setSnapshot({ error: controller.signal.aborted ? '和播放器宿主联系超时，正在重试' : message })
        } finally {
          window.clearTimeout(timer)
          syncPromise = null
        }
      })()
      return syncPromise
    }

    const applyCommands = (commands) => {
      if (!Array.isArray(commands) || !commands.length) return
      for (const command of commands) {
        if (appliedCommandIds.has(command.id)) { pendingAckIds.add(command.id); continue }
        appliedCommandIds.add(command.id)
        pendingAckIds.add(command.id)
        if (appliedCommandIds.size > 300) {
          // 只留最近 150 个 id，防止长跑会话里集合无限长。
          const keep = [...appliedCommandIds].slice(-150)
          appliedCommandIds.clear()
          for (const id of keep) appliedCommandIds.add(id)
        }
        try {
          switch (command.action) {
            case 'play': resume(); break
            case 'pause': pause(); break
            case 'toggle': toggle(); break
            case 'next': step(1); break
            case 'prev': step(-1); break
            case 'volume': setVolume(command.value); break
            case 'seek': seek(Number(command.value)); break
            case 'repeat': setPlayer({ repeat: command.value }); break
            case 'shuffle': setPlayer({ shuffle: Boolean(command.value) }); break
            case 'playTrack': playTrack(String(command.value)); break
            case 'videoWindow': setVideoOpen(Boolean(command.value)); break
            case 'openPanel': setUi({ panelOpen: true }); scheduleReport(); break
            case 'closePanel': setUi({ panelOpen: false, recording: null }); scheduleReport(); break
            default: break
          }
        } catch (error) {
          // 单条命令坏掉不影响其它，但把原因记下来（面板/诊断能看到）
          setPlayer({ error: '遥控命令失败：' + String((error && error.message) || error) })
        }
      }
      // 统一在 syncState 里 flushAcks()，这里只负责把 id 记进待确认队列。
    }

    let pollTimer = 0
    let pollGeneration = 0
    const startPolling = () => {
      // 代数守卫：插件被热替换后，上一代的 setTimeout 链可能还挂在那里，
      // 它们会继续拉状态、继续 ack 遥控命令，把命令吞掉。代数一变就整体失效。
      const generation = ++pollGeneration
      if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = 0 }
      const tick = () => {
        if (generation !== pollGeneration) return
        const interval = ui.visible ? (ui.panelOpen ? 2000 : 6000) : 25000
        pollTimer = window.setTimeout(async () => {
          if (generation !== pollGeneration) return
          if (ui.visible) await syncState()
          tick()
        }, interval)
      }
      tick()
    }
    const stopPolling = () => {
      pollGeneration += 1
      if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = 0 }
    }

    // ── 快捷键 ────────────────────────────────────────────────────────
    const shortcutActionMap = {
      playPause: () => toggle(),
      next: () => step(1),
      prev: () => step(-1),
      volumeUp: () => setVolume(player.volume + 0.05),
      volumeDown: () => setVolume(player.volume - 0.05),
      mute: () => toggleMute(),
      togglePanel: () => setUi({ panelOpen: !ui.panelOpen }),
      videoWindow: () => setVideoOpen(!ui.videoOpen),
      fullscreen: () => toggleVideoFullscreen(),
      seekForward: () => seek(getPosition() + 5),
      seekBack: () => seek(getPosition() - 5),
      close: () => { setUi({ panelOpen: false, videoOpen: false, recording: null }) },
    }

    const comboOf = (event) => {
      const code = event.code || ''
      if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return ''
      const parts = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      parts.push(code)
      return parts.join('+')
    }
    const prettyCombo = (combo) => String(combo || '')
      .replace(/\bKey([A-Z0-9])/g, '$1')
      .replace(/\bDigit(\d)/g, '$1')
      .replace(/^Space$/, '空格')
      .replace(/ArrowLeft/g, '←').replace(/ArrowRight/g, '→').replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓')
      .replace(/Escape/g, 'Esc')
      .replace(/\+/g, ' + ')

    const isTyping = (target) => {
      if (!target) return false
      const tag = String(target.tagName || '').toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true
    }
    const saveShortcuts = (next) => {
      setSnapshot({ settings: { ...snapshot.settings, shortcuts: next } })
      void postJson(API + '/settings', { patch: { shortcuts: next } }).catch(() => {})
    }
    const handleKey = (event) => {
      if (event.defaultPrevented || event.isComposing) return
      // 全屏时 Esc 交给浏览器退出全屏，别被我们截走
      if (event.key === 'Escape' && document.fullscreenElement) return
      const combo = comboOf(event)
      if (!combo) return
      // 录制中：这一下就是新键位；Esc / Tab 当取消，别把「关面板」按成快捷键。
      if (ui.recording) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape' || event.key === 'Tab') {
          setUi({ recording: null })
          flash('已取消录制')
          return
        }
        const { scope, action } = ui.recording
        const shortcuts = snapshot.settings.shortcuts || { global: {}, panel: {} }
        const next = { global: { ...shortcuts.global }, panel: { ...shortcuts.panel } }
        next[scope][action] = combo
        saveShortcuts(next)
        setUi({ recording: null })
        return
      }
      // 录制状态残留的兜底：面板关着却还在录，说明用户已经离开了这个页签。
      if (ui.recording && !ui.panelOpen) setUi({ recording: null })
      if (isTyping(event.target)) return
      const shortcuts = snapshot.settings.shortcuts || { global: {}, panel: {} }
      if (ui.panelOpen && shortcuts.panel) {
        for (const [action, binding] of Object.entries(shortcuts.panel)) {
          if (binding && binding === combo && shortcutActionMap[action]) {
            event.preventDefault()
            shortcutActionMap[action]()
            return
          }
        }
      }
      for (const [action, binding] of Object.entries(shortcuts.global || {})) {
        if (binding && binding === combo && shortcutActionMap[action]) {
          event.preventDefault()
          shortcutActionMap[action]()
          return
        }
      }
    }

    // ── 视频窗几何 ────────────────────────────────────────────────────
    const VIDEO_RECT_KEY = 'dsh-music-video-rect'
    const defaultVideoRect = () => ({
      x: Math.max(24, Math.round(window.innerWidth - 560)),
      y: 84,
      w: 480,
      h: 300,
    })
    const loadRect = () => {
      try {
        const raw = JSON.parse(window.localStorage.getItem(VIDEO_RECT_KEY) || 'null')
        if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.w) && Number.isFinite(raw.h)) {
          return { x: Math.max(0, raw.x), y: Math.max(0, raw.y), w: Math.max(240, raw.w), h: Math.max(150, raw.h) }
        }
      } catch { /* 忽略坏数据 */ }
      return defaultVideoRect()
    }
    const saveRect = (rect) => {
      try { window.localStorage.setItem(VIDEO_RECT_KEY, JSON.stringify(rect)) } catch { /* ignore */ }
    }

    // ── 面板位置与尺寸（可拖动、可缩放，记在 localStorage） ────────────
    const PANEL_RECT_KEY = 'dsh-music-panel-rect'
    const clampRect = (rect) => {
      const minW = 330
      const minH = 260
      const maxW = Math.max(minW, window.innerWidth - 16)
      const maxH = Math.max(minH, window.innerHeight - 16)
      return {
        x: Math.max(0, Math.min(rect.x, window.innerWidth - 120)),
        y: Math.max(0, Math.min(rect.y, window.innerHeight - 60)),
        w: Math.max(minW, Math.min(rect.w, maxW)),
        h: Math.max(minH, Math.min(rect.h, maxH)),
      }
    }
    const defaultPanelRect = () => clampRect({
      x: Math.max(12, window.innerWidth - 446 - 22),
      y: 58,
      w: 446,
      h: Math.min(window.innerHeight - 90, 660),
    })
    const loadPanelRect = () => {
      try {
        const raw = JSON.parse(window.localStorage.getItem(PANEL_RECT_KEY) || 'null')
        if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.w) && Number.isFinite(raw.h)) {
          return clampRect(raw)
        }
      } catch { /* 坏数据就回默认 */ }
      return defaultPanelRect()
    }
    const savePanelRect = (rect) => {
      try { window.localStorage.setItem(PANEL_RECT_KEY, JSON.stringify(rect)) } catch { /* ignore */ }
    }

    // ── 样式 ──────────────────────────────────────────────────────────
    const CSS = `
.mp-mini{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);max-width:360px;cursor:pointer;user-select:none;
  transition:border-color .18s,transform .18s;}
.mp-mini:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px);}
.mp-mini-title{font-size:12px;line-height:1;opacity:.85;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mp-mini-kind{display:grid;place-items:center;flex:0 0 11px;opacity:.75;color:var(--dsw-alias-brand-primary);}
.mp-mini[data-idle="1"] .mp-mini-title{opacity:.6;}
.mp-mini-btn{display:grid;place-items:center;width:22px;height:22px;border:0;border-radius:50%;
  background:transparent;color:inherit;cursor:pointer;padding:0;transition:background .15s,color .15s;}
.mp-mini-btn:hover{background:rgba(127,127,127,.16);color:var(--dsw-alias-brand-primary);}
.mp-mini-btn:disabled{opacity:.35;cursor:default;}
.mp-state{display:grid;place-items:center;width:15px;height:15px;flex:0 0 15px;color:var(--dsw-alias-brand-primary);}
.mp-state svg{display:block;}
[data-mp-anim="on"] .mp-state{animation:mp-swap .22s ease-out;}
@keyframes mp-swap{0%{transform:scale(.55) rotate(-12deg);opacity:.35}70%{transform:scale(1.12) rotate(0)}100%{transform:scale(1);opacity:1}}
[data-mp-anim="on"] .mp-state[data-playing="1"] svg{animation:mp-beat 1.3s ease-in-out infinite;}
@keyframes mp-beat{0%,100%{transform:scaleY(1)}45%{transform:scaleY(.82)}}
[data-mp-anim="on"] .mp-flip{animation:mp-flip .22s ease-out;display:grid;place-items:center;}
@keyframes mp-flip{0%{transform:scale(.6);opacity:.4}100%{transform:scale(1);opacity:1}}

[data-mp-panel]{position:fixed;left:0;top:0;z-index:70;width:446px;height:640px;
  min-width:330px;min-height:260px;
  display:flex;flex-direction:column;overflow:hidden;color:var(--mp-text);pointer-events:auto;
  background:color-mix(in srgb, var(--mp-surface) calc(var(--mp-opacity) * 100%), transparent);
  backdrop-filter:blur(var(--mp-blur)) saturate(1.25);-webkit-backdrop-filter:blur(var(--mp-blur)) saturate(1.25);
  border:1px solid color-mix(in srgb, var(--mp-accent) 26%, transparent);border-radius:var(--mp-radius);
  box-shadow:0 24px 64px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.04) inset;
  font-size:13px;transform-origin:top right;}
[data-mp-anim="on"][data-mp-panel]{animation:mp-pop .2s ease-out;}
@keyframes mp-pop{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
[data-mp-panel][data-mp-glow="1"]{box-shadow:0 24px 64px rgba(0,0,0,.42),0 0 28px color-mix(in srgb, var(--mp-accent) 30%, transparent),0 0 0 1px rgba(255,255,255,.04) inset;}
[data-mp-panel] *{box-sizing:border-box;}

.mp-head{display:flex;gap:12px;padding:13px 14px 9px;align-items:center;cursor:grab;user-select:none;}
.mp-head:active{cursor:grabbing;}
.mp-head button{cursor:pointer;}
.mp-grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:5;
  background:linear-gradient(135deg,transparent 52%,color-mix(in srgb,var(--mp-accent) 55%,transparent) 52%);}
.mp-cover{width:56px;height:56px;border-radius:12px;flex:0 0 56px;object-fit:cover;background:rgba(127,127,127,.16);
  box-shadow:0 6px 18px rgba(0,0,0,.28);}
.mp-cover-fallback{display:grid;place-items:center;font-size:20px;font-weight:600;
  background:linear-gradient(135deg,color-mix(in srgb,var(--mp-accent) 55%,transparent),color-mix(in srgb,var(--mp-accent) 12%,transparent));}
.mp-head-main{flex:1;min-width:0;}
.mp-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mp-artist{font-size:11px;opacity:.66;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mp-tags{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap;}
.mp-tag{font-size:10px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--mp-accent) 22%,transparent);
  color:var(--mp-text);opacity:.9;white-space:nowrap;}
.mp-tag[data-kind="video"]{background:color-mix(in srgb,#ff9d54 30%,transparent);}
.mp-close{margin-left:auto;align-self:flex-start;border:0;background:transparent;color:inherit;opacity:.55;
  cursor:pointer;font-size:15px;line-height:1;padding:4px;border-radius:6px;transition:opacity .15s,background .15s;}
.mp-close:hover{opacity:1;background:rgba(127,127,127,.16);}

.mp-progress{padding:0 14px 4px;display:flex;flex-direction:column;gap:4px;}
.mp-bar{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;outline:none;cursor:pointer;
  background:linear-gradient(to right,var(--mp-accent) var(--mp-pct,0%),rgba(127,127,127,.28) var(--mp-pct,0%));}
.mp-bar::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--mp-accent);
  border:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--mp-accent) 25%,transparent);}
.mp-times{display:flex;justify-content:space-between;font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;}

.mp-transport{display:flex;align-items:center;gap:5px;padding:5px 12px 9px;}
.mp-ctrl{display:grid;place-items:center;width:29px;height:29px;border:0;border-radius:50%;background:transparent;
  color:inherit;cursor:pointer;padding:0;transition:background .15s,color .15s,transform .15s;}
.mp-ctrl:hover{background:rgba(127,127,127,.18);color:var(--mp-accent);}
.mp-ctrl[data-active="1"]{color:var(--mp-accent);}
.mp-ctrl:disabled{opacity:.3;cursor:default;}
.mp-play{width:37px;height:37px;background:var(--mp-accent);color:#04121f;
  box-shadow:0 6px 16px color-mix(in srgb,var(--mp-accent) 40%,transparent);}
.mp-play:hover{background:var(--mp-accent);color:#04121f;transform:scale(1.04);}
.mp-vol{display:flex;align-items:center;gap:5px;margin-left:auto;min-width:84px;}
.mp-vol .mp-bar{height:3px;}

.mp-tabs{display:flex;gap:1px;padding:0 8px;border-bottom:1px solid color-mix(in srgb,var(--mp-text) 12%,transparent);}
.mp-tab{border:0;background:transparent;color:inherit;opacity:.6;font-size:12px;padding:7px 9px;cursor:pointer;
  border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s;}
.mp-tab:hover{opacity:.9;}
.mp-tab[data-on="1"]{opacity:1;border-bottom-color:var(--mp-accent);font-weight:600;}

.mp-body{flex:1;overflow:auto;padding:8px 9px 12px;scrollbar-width:thin;}
.mp-body::-webkit-scrollbar{width:8px;}
.mp-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--mp-text) 18%,transparent);border-radius:8px;}

.mp-toolbar{display:flex;gap:5px;align-items:center;padding:2px 1px 7px;flex-wrap:wrap;}
.mp-input{flex:1;min-width:100px;padding:6px 9px;border-radius:8px;font-size:12px;color:inherit;
  border:1px solid color-mix(in srgb,var(--mp-text) 22%,transparent);
  background:color-mix(in srgb,var(--mp-text) 8%,transparent);outline:none;transition:border-color .15s;}
.mp-input::placeholder{color:currentColor;opacity:.42;}
.mp-input:focus{border-color:var(--mp-accent);}
.mp-select{padding:6px 7px;border-radius:8px;font-size:12px;color:inherit;cursor:pointer;
  border:1px solid color-mix(in srgb,var(--mp-text) 22%,transparent);background:color-mix(in srgb,var(--mp-text) 8%,transparent);}
.mp-select option{color:#111;background:#fff;}
.mp-btn{padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;color:inherit;
  border:1px solid color-mix(in srgb,var(--mp-text) 22%,transparent);
  background:color-mix(in srgb,var(--mp-text) 8%,transparent);transition:background .15s,border-color .15s,color .15s;}
.mp-btn:hover{border-color:var(--mp-accent);color:var(--mp-accent);}
.mp-btn[disabled]{opacity:.45;cursor:default;}
.mp-btn[data-on="1"]{border-color:var(--mp-accent);color:var(--mp-accent);background:color-mix(in srgb,var(--mp-accent) 14%,transparent);}
.mp-btn-primary{background:var(--mp-accent);border-color:transparent;color:#04121f;font-weight:600;}
.mp-btn-primary:hover{background:var(--mp-accent);color:#04121f;filter:brightness(1.06);}
.mp-chips{display:flex;gap:5px;flex-wrap:wrap;padding:0 1px 7px;}
.mp-chip{border:1px solid color-mix(in srgb,var(--mp-text) 20%,transparent);background:transparent;color:inherit;
  font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;transition:all .15s;white-space:nowrap;}
.mp-chip:hover{border-color:var(--mp-accent);color:var(--mp-accent);}
.mp-chip[data-on="1"]{background:color-mix(in srgb,var(--mp-accent) 26%,transparent);border-color:transparent;color:var(--mp-text);}
.mp-chip small{opacity:.6;margin-left:3px;font-size:9.5px;}

.mp-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:10px;cursor:pointer;
  transition:background .15s;}
.mp-row:hover{background:color-mix(in srgb,var(--mp-text) 8%,transparent);}
.mp-row[data-current="1"]{background:color-mix(in srgb,var(--mp-accent) 18%,transparent);}
.mp-row[data-picked="1"]{background:color-mix(in srgb,#ff9d54 16%,transparent);}
.mp-row-idx{width:18px;flex:0 0 18px;font-size:10px;opacity:.45;text-align:right;font-variant-numeric:tabular-nums;}
.mp-row-kind{width:14px;flex:0 0 14px;font-size:10px;opacity:.62;display:grid;place-items:center;}
.mp-row-main{flex:1;min-width:0;}
.mp-row-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mp-row-sub{font-size:10.5px;opacity:.55;margin-top:2px;display:flex;gap:5px;align-items:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mp-row-sub .mp-pl{color:var(--mp-accent);opacity:.95;}
.mp-row-act{display:flex;gap:1px;opacity:0;transition:opacity .15s;}
.mp-row:hover .mp-row-act,.mp-row[data-current="1"] .mp-row-act{opacity:1;}
.mp-row-act button{border:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font-size:11px;
  padding:3px 4px;border-radius:6px;line-height:1;}
.mp-row-act button:hover{opacity:1;background:rgba(127,127,127,.2);color:var(--mp-accent);}
.mp-row-act button[data-on="1"]{opacity:1;color:#ffcf5c;}
.mp-row:focus-visible{outline:2px solid var(--mp-accent);outline-offset:-2px;}
.mp-row:focus-within .mp-row-act{opacity:1;}
@media (hover:none){.mp-row-act{opacity:1;}}
.mp-bar:focus-visible{outline:2px solid var(--mp-accent);outline-offset:3px;}
.mp-empty{padding:24px 12px;text-align:center;font-size:12px;opacity:.55;line-height:1.8;}
.mp-check{width:13px;height:13px;accent-color:var(--mp-accent);cursor:pointer;flex:0 0 13px;}

.mp-hint{font-size:11px;opacity:.55;line-height:1.7;padding:2px 1px 7px;}
.mp-msg{font-size:11px;padding:6px 9px;border-radius:8px;margin:5px 9px;
  background:color-mix(in srgb,var(--mp-accent) 16%,transparent);}
.mp-msg[data-kind="error"]{background:color-mix(in srgb,#ff6b6b 24%,transparent);}
.mp-job{font-size:11px;display:flex;gap:7px;align-items:center;opacity:.85;padding:1px 2px;}
.mp-job-bar{flex:1;height:3px;border-radius:999px;background:rgba(127,127,127,.25);overflow:hidden;}
.mp-job-bar i{display:block;height:100%;background:var(--mp-accent);transition:width .4s;}
.mp-jobs{padding:0 1px 7px;display:flex;flex-direction:column;gap:3px;}

.mp-sec{font-size:11px;opacity:.55;padding:7px 1px 5px;letter-spacing:.03em;}
.mp-skins{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding-bottom:7px;}
.mp-skin{border:1px solid color-mix(in srgb,var(--mp-text) 18%,transparent);border-radius:9px;padding:6px 7px;
  cursor:pointer;font-size:11px;display:flex;flex-direction:column;gap:4px;background:transparent;color:inherit;
  text-align:left;transition:border-color .15s,transform .15s;}
.mp-skin:hover{transform:translateY(-1px);}
.mp-skin[data-on="1"]{border-color:var(--mp-accent);}
.mp-dot{width:100%;height:8px;border-radius:999px;display:block;}
.mp-field{display:flex;align-items:center;gap:7px;padding:4px 1px;font-size:11.5px;}
.mp-field > label{flex:0 0 58px;opacity:.7;}
.mp-field .mp-bar{height:4px;}
.mp-color{width:32px;height:21px;padding:0;border:1px solid color-mix(in srgb,var(--mp-text) 22%,transparent);
  border-radius:6px;background:transparent;cursor:pointer;}
.mp-kbd{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;padding:1px 5px;border-radius:4px;
  border:1px solid color-mix(in srgb,var(--mp-text) 26%,transparent);opacity:.85;}
.mp-res{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:10px;transition:background .15s;}
.mp-res:hover{background:color-mix(in srgb,var(--mp-text) 8%,transparent);}
.mp-res img{width:44px;height:28px;border-radius:6px;object-fit:cover;background:rgba(127,127,127,.16);flex:0 0 44px;}
.mp-res-main{flex:1;min-width:0;}
.mp-res-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mp-res-sub{font-size:10.5px;opacity:.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

.mp-batch{display:flex;gap:5px;align-items:center;flex-wrap:wrap;padding:6px 7px;margin:0 1px 6px;border-radius:9px;
  background:color-mix(in srgb,#ff9d54 16%,transparent);font-size:11px;}

.mp-video{position:fixed;z-index:80;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;
  background:#05080d;color:#dce8f5;border:1px solid color-mix(in srgb,var(--mp-accent, #54b8ff) 34%,transparent);
  border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);min-width:260px;min-height:170px;}
.mp-video[data-full="1"]{left:0!important;top:0!important;width:100vw!important;height:100vh!important;border-radius:0;z-index:120;}
.mp-video:fullscreen{left:0!important;top:0!important;width:100vw!important;height:100vh!important;
  border-radius:0;border:0;box-shadow:none;z-index:2147483000;}
.mp-video:fullscreen .mp-video-grip{display:none;}
.mp-video:fullscreen .mp-video-head,
.mp-video:fullscreen .mp-video-foot{position:absolute;left:0;right:0;z-index:4;transition:opacity .22s ease,transform .22s ease;}
.mp-video:fullscreen .mp-video-head{top:0;background:linear-gradient(180deg,rgba(0,0,0,.72),transparent);padding:10px 16px;}
.mp-video:fullscreen .mp-video-foot{bottom:0;flex-direction:column;align-items:stretch;gap:6px;padding:14px 18px 16px;
  background:linear-gradient(0deg,rgba(0,0,0,.82),transparent);}
.mp-video:fullscreen .mp-video-stage{position:absolute;inset:0;}
.mp-video:fullscreen[data-idle="1"] .mp-video-head{opacity:0;transform:translateY(-8px);pointer-events:none;}
.mp-video:fullscreen[data-idle="1"] .mp-video-foot{opacity:0;transform:translateY(10px);pointer-events:none;}
.mp-video:fullscreen[data-idle="1"]{cursor:none;}
.mp-video-head{display:flex;align-items:center;gap:6px;padding:5px 7px;cursor:move;user-select:none;
  background:linear-gradient(180deg,rgba(20,30,44,.96),rgba(10,16,24,.9));color:#dce8f5;font-size:11px;}
.mp-video-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8;}
.mp-video-btn{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.7;font-size:11px;
  padding:2px 5px;border-radius:5px;line-height:1;}
.mp-video-btn:hover{opacity:1;background:rgba(127,127,127,.24);}
.mp-video-stage{flex:1;min-height:0;position:relative;background:#000;}
.mp-video-tip{position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:#9db4cc;
  font-size:12px;line-height:1.8;padding:18px;}
.mp-video-foot{display:flex;flex-direction:column;gap:4px;padding:5px 8px 6px;background:rgba(10,16,24,.92);}
.mp-video-line{display:flex;align-items:center;gap:6px;}
.mp-video-line .mp-bar{height:4px;flex:1;}
.mp-video-time{font-size:10px;color:#9db4cc;font-variant-numeric:tabular-nums;white-space:nowrap;}
.mp-video-ctrls{display:flex;align-items:center;gap:3px;}
.mp-video-vol{display:flex;align-items:center;gap:5px;margin-left:auto;min-width:84px;}
.mp-video-vol .mp-bar{height:3px;flex:1;}
.mp-video-hint{position:absolute;left:50%;bottom:70px;transform:translateX(-50%);z-index:5;
  font-size:11px;color:#cfe0f2;opacity:.55;transition:opacity .22s;white-space:nowrap;pointer-events:none;}
[data-idle="1"] .mp-video-hint{opacity:0;}
.mp-video-grip{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.25) 50%);}

.mp-think{display:inline-flex;align-items:center;gap:5px;font-size:11px;opacity:.75;}
[data-mp-anim="on"] .mp-think i{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--mp-accent);
  animation:mp-dot 1.1s ease-in-out infinite;}
[data-mp-anim="on"] .mp-think i:nth-child(2){animation-delay:.18s;}
[data-mp-anim="on"] .mp-think i:nth-child(3){animation-delay:.36s;}
@keyframes mp-dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
`

    // ── 图标 ──────────────────────────────────────────────────────────
    const icon = (path, size = 15) => h('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': true,
      style: { display: 'block' },
    }, h('path', { d: path }))
    const ICON = {
      play: 'M8 5.14v13.72L19 12 8 5.14z',
      pause: 'M7 5h4v14H7V5zm6 0h4v14h-4V5z',
      prev: 'M7 6h2v12H7V6zm3 6l8-6v12l-8-6z',
      next: 'M15 6h2v12h-2V6zM6 6l8 6-8 6V6z',
      volume: 'M4 9h4l5-4v14l-5-4H4V9zm12.5 3a4.5 4.5 0 0 0-2-3.7v7.4a4.5 4.5 0 0 0 2-3.7z',
      mute: 'M4 9h4l5-4v14l-5-4H4V9zm11.6 1.9L17.5 9l1.4 1.4 1.4-1.4 1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.3-1.4z',
      shuffle: 'M17 3h4v4h-2V6.4l-4.3 4.3-1.4-1.4L17.6 5H17V3zM3 6h4.2l3 3-1.4 1.4L6.3 8H3V6zm14 11v-1.4l-4.3-4.3-1.4 1.4L15.6 17H15v2h4v-4h-2zM3 16h3.3l3-3 1.4 1.4-3.4 3.6H3v-2z',
      repeat: 'M7 7h10v3l3-4-3-4v3H5v6h2V7zm10 10H7v-3l-3 4 3 4v-3h12v-6h-2v4z',
      repeatOne: 'M7 7h10v3l3-4-3-4v3H5v6h2V7zm10 10H7v-3l-3 4 3 4v-3h12v-6h-2v4zM12 10v5h1.4v-4.4L12 10z',
      video: 'M4 6h11a1 1 0 0 1 1 1v3.5l4-2.3v9.6l-4-2.3V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
      // 胶卷：片条 + 两排齿孔（evenodd 挖空），比播放三角好认
      film: 'M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'
        + 'M3.6 7h3.4v3H3.6zM9 7h3.4v3H9zM14.4 7h3.4v3h-3.4zM20.4 7H22v3h-1.6z'
        + 'M3.6 14h3.4v3H3.6zM9 14h3.4v3H9zM14.4 14h3.4v3h-3.4zM20.4 14H22v3h-1.6z',
      close: 'M6 6l12 12M18 6L6 18',
    }

    /** 胶卷图标（视频专用标记）。 */
    const filmIcon = (size = 12) => h('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'fill-rule': 'evenodd',
      'aria-hidden': true, style: { display: 'block' },
    }, h('path', { d: ICON.film }))

    // ── 迷你播放器 ────────────────────────────────────────────────────
    function MiniPlayer() {
      const state = useStore()
      const current = usePlayer()
      const uiState = useUi()
      const track = current.trackId ? state.tracks.find(item => item.id === current.trackId) : null
      const label = track ? track.title + (track.artist ? ' · ' + track.artist : '') : '点这里放歌'
      const skin = state.settings.skin || DEFAULT_SKIN
      const animOn = skin.anim !== false && uiState.visible
      React.useEffect(() => { beacon('mini-mounted') }, [])
      return h('div', {
        className: 'mp-mini',
        'data-idle': track ? '0' : '1',
        'data-mp-anim': animOn ? 'on' : 'off',
        title: track ? label : '打开播放器',
        onClick: () => setUi({ panelOpen: !ui.panelOpen }),
      },
        h('span', {
          className: 'mp-state',
          'data-playing': current.playing ? '1' : '0',
          key: current.playing ? 'playing' : 'paused',
          title: current.playing ? '正在播放' : '已暂停',
        }, h('span', { className: 'mp-flip' }, icon(current.playing ? ICON.pause : ICON.play, 12))),
        track && track.kind === 'video'
          ? h('span', { className: 'mp-mini-kind', title: '视频' }, filmIcon(11))
          : null,
        h('span', { className: 'mp-mini-title' }, label),
        h('button', {
          type: 'button', className: 'mp-mini-btn', title: '上一首', disabled: !state.tracks.length,
          onClick: (event) => { event.stopPropagation(); step(-1) },
        }, icon(ICON.prev, 13)),
        h('button', {
          type: 'button', className: 'mp-mini-btn', title: current.playing ? '暂停' : '播放',
          disabled: !state.tracks.length,
          onClick: (event) => { event.stopPropagation(); toggle() },
        }, icon(current.playing ? ICON.pause : ICON.play, 13)),
        h('button', {
          type: 'button', className: 'mp-mini-btn', title: '下一首', disabled: !state.tracks.length,
          onClick: (event) => { event.stopPropagation(); step(1) },
        }, icon(ICON.next, 13)),
      )
    }

    // ── 视频窗 ────────────────────────────────────────────────────────
    function VideoWindow() {
      const current = usePlayer()
      const position = usePosition()
      const uiState = useUi()
      const state = useStore()
      const hostRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const [rect, setRect] = React.useState(() => loadRect())
      const [fullscreen, setFullscreen] = React.useState(false)
      const [idle, setIdle] = React.useState(false)
      const dragRef = React.useRef(null)
      const idleTimer = React.useRef(0)
      const track = current.trackId ? state.tracks.find(item => item.id === current.trackId) : null
      const isVideo = current.kind === 'video'
      const skin = state.settings.skin || DEFAULT_SKIN

      // 把根节点交给模块级快捷键用（全屏开关要在面板/快捷键里也能触发）
      React.useEffect(() => {
        videoRootEl = rootRef.current
        return () => { if (videoRootEl === rootRef.current) videoRootEl = null }
      })

      // 跟随系统全屏状态：Esc 退出、系统打断都能同步回来
      React.useEffect(() => {
        const onChange = () => {
          const active = Boolean(rootRef.current && document.fullscreenElement === rootRef.current)
          setFullscreen(active)
          if (!active) setIdle(false)
        }
        document.addEventListener('fullscreenchange', onChange)
        return () => document.removeEventListener('fullscreenchange', onChange)
      }, [])

      const hideIdle = React.useCallback(() => {
        // 全屏 + 正在播 + 鼠标静默 → 收控件；暂停或没全屏就留着
        if (document.fullscreenElement && player.playing) setIdle(true)
      }, [])

      const bumpActivity = React.useCallback(() => {
        setIdle(false)
        if (idleTimer.current) window.clearTimeout(idleTimer.current)
        idleTimer.current = window.setTimeout(hideIdle, 2600)
      }, [hideIdle])

      React.useEffect(() => {
        if (!fullscreen) {
          if (idleTimer.current) window.clearTimeout(idleTimer.current)
          setIdle(false)
          return undefined
        }
        bumpActivity()
        const onMove = () => bumpActivity()
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerdown', onMove)
        window.addEventListener('keydown', onMove)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerdown', onMove)
          window.removeEventListener('keydown', onMove)
          if (idleTimer.current) window.clearTimeout(idleTimer.current)
        }
      }, [fullscreen, bumpActivity])

      React.useEffect(() => {
        const el = ensureVideo()
        const host = hostRef.current
        if (!host) return undefined
        if (el.parentNode !== host) {
          el.style.width = '100%'
          el.style.height = '100%'
          host.appendChild(el)
        }
        // 元素在容器间搬家后浏览器可能把播放挂起，按当前播放状态补一脚
        if (player.playing && el.paused) {
          const attempt = el.play()
          if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {})
        }
        beacon('video-mounted')
        // 窗口收起时把元素停到隐藏容器，保证它仍在文档里（否则 seekable 会塌掉）
        return () => { parkVideo() }
      }, [uiState.videoOpen])

      React.useEffect(() => {
        const move = (event) => {
          const drag = dragRef.current
          if (!drag) return
          const dx = event.clientX - drag.x0
          const dy = event.clientY - drag.y0
          setRect({
            x: Math.max(0, Math.min(window.innerWidth - 120, drag.rect.x + dx)),
            y: Math.max(0, Math.min(window.innerHeight - 60, drag.rect.y + dy)),
            w: drag.rect.w,
            h: drag.rect.h,
          })
        }
        const up = () => {
          if (!dragRef.current) return
          dragRef.current = null
          setRect((value) => { saveRect(value); return value })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [])

      if (!uiState.videoOpen) return null
      const animOn = skin.anim !== false && uiState.visible
      const hasTracks = state.tracks.length > 0

      const startDrag = (event) => {
        if (fullscreen) return
        dragRef.current = { x0: event.clientX, y0: event.clientY, rect }
      }
      const toggleFullscreen = async () => {
        const el = rootRef.current
        if (!el) return
        try {
          if (document.fullscreenElement) await document.exitFullscreen()
          else if (el.requestFullscreen) await el.requestFullscreen()
        } catch { /* 某些环境下不允许，保持原样 */ }
      }

      const ctrl = (props, path, size, title) => h('button', {
        type: 'button', className: 'mp-ctrl', title,
        ...props,
      }, icon(path, size))

      return h('div', {
        ref: rootRef,
        className: 'mp-video',
        'data-mp-anim': animOn ? 'on' : 'off',
        'data-fullscreen': fullscreen ? '1' : '0',
        'data-idle': idle ? '1' : '0',
        style: {
          '--mp-accent': skin.accent,
          ...(fullscreen ? {} : { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }),
        },
        onPointerDown: (event) => { event.stopPropagation(); if (fullscreen) bumpActivity() },
        onPointerMove: () => { if (fullscreen) bumpActivity() },
      },
        h('div', { className: 'mp-video-head', onPointerDown: startDrag },
          isVideo ? filmIcon(11) : h('span', null, '♪'),
          h('span', { className: 'mp-video-title' }, track ? track.title : '视频窗'),
          h('button', {
            type: 'button', className: 'mp-video-btn', title: '画中画（浮到系统最上层）',
            onClick: () => {
              const el = videoEl
              if (!el) return
              try {
                if (document.pictureInPictureElement) document.exitPictureInPicture()
                else el.requestPictureInPicture()
              } catch { /* 不支持就忽略 */ }
            },
          }, 'PiP'),
          h('button', {
            type: 'button', className: 'mp-video-btn', title: fullscreen ? '退出全屏（Esc）' : '全屏（默认 Ctrl+Shift+F）',
            onClick: () => void toggleFullscreen(),
          }, fullscreen ? '还原' : '全屏'),
          h('button', {
            type: 'button', className: 'mp-video-btn', title: '关闭视频窗（不影响播放）',
            onClick: () => setVideoOpen(false),
          }, '✕'),
        ),
        h('div', { className: 'mp-video-stage' },
          h('div', { ref: hostRef, style: { position: 'absolute', inset: 0 } }),
          isVideo ? null : h('div', { className: 'mp-video-tip' },
            '这段是音频，没有画面。', h('br'),
            track ? '点「下一首」跳到视频，或者在曲库里挑一个胶卷标记的。' : '还没有在播的内容。'),
          idle ? null : h('div', { className: 'mp-video-hint' },
            'Esc 退出全屏 · 空格 播放/暂停 · ←/→ 切歌 · ↑/↓ 音量'),
        ),
        h('div', { className: 'mp-video-foot' },
          h('div', { className: 'mp-video-line' },
            progressBar(position, mediaDuration(), seek),
            h('span', { className: 'mp-video-time' },
              fmtTime(position, mediaDuration() > 0 && mediaDuration() < 10)
              + ' / ' + (mediaDuration() > 0 ? fmtTime(mediaDuration(), mediaDuration() < 10) : '--:--')
              + (current.streaming ? ' · 流式' : '')),
          ),
          h('div', { className: 'mp-video-line' },
            h('div', { className: 'mp-video-ctrls' },
              ctrl({ disabled: !hasTracks, onClick: () => step(-1) }, ICON.prev, 14, '上一首'),
              ctrl({
                disabled: !hasTracks, onClick: () => toggle(),
                style: { background: skin.accent, color: '#04121f' },
              }, current.playing ? ICON.pause : ICON.play, 15, current.playing ? '暂停' : '播放'),
              ctrl({ disabled: !hasTracks, onClick: () => step(1) }, ICON.next, 14, '下一首'),
            ),
            h('div', { className: 'mp-video-vol' },
              ctrl({
                onClick: () => toggleMute(),
                title: current.muted ? '取消静音' : '静音',
              }, current.muted || current.volume === 0 ? ICON.mute : ICON.volume, 14, current.muted ? '取消静音' : '静音'),
              h('input', {
                className: 'mp-bar', type: 'range', min: 0, max: 100,
                value: Math.round((current.muted ? 0 : current.volume) * 100),
                style: { '--mp-pct': Math.round((current.muted ? 0 : current.volume) * 100) + '%' },
                onChange: (event) => setVolume(Number(event.target.value) / 100),
              }),
            ),
          ),
        ),
        fullscreen ? null : h('div', {
          className: 'mp-video-grip',
          onPointerDown: (event) => {
            event.stopPropagation()
            const startX = event.clientX
            const startY = event.clientY
            const base = rect
            const move = (moveEvent) => {
              setRect({
                x: base.x,
                y: base.y,
                w: Math.max(240, base.w + (moveEvent.clientX - startX)),
                h: Math.max(150, base.h + (moveEvent.clientY - startY)),
              })
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              setRect((value) => { saveRect(value); return value })
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          },
        }),
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────
    function Panel(props) {
      const state = useStore()
      const current = usePlayer()
      const position = usePosition()
      const uiState = useUi()
      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      // 只订阅「主视图会话 id」这一个字符串。旧的恒等 selector 会让面板跟着会话 store
      // 的每一次变化（流式输出时每帧）重渲染整个曲库。
      const mainSessionId = useSessions ? useSessions((list) => {
        if (!list || !list.byId) return ''
        const rows = Object.values(list.byId)
        const main = rows.find(row => row && row.retainedBy && row.retainedBy.mainView > 0)
        return (main && main.id) || ''
      }) : ''
      const sessionId = mainSessionId || ''

      const [tab, setTab] = React.useState('list')
      const [filter, setFilter] = React.useState('')
      const [playlistId, setPlaylistId] = React.useState('')
      const [picked, setPicked] = React.useState({})
      const [batchMode, setBatchMode] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [results, setResults] = React.useState([])
      const [selected, setSelected] = React.useState({})
      const [searchKind, setSearchKind] = React.useState('audio')
      const [searching, setSearching] = React.useState(false)
      const [prompt, setPrompt] = React.useState('')
      const [askMode, setAskMode] = React.useState(state.settings.askMode || 'discover')
      const [think, setThink] = React.useState(state.settings.askThink !== false)
      const [askResult, setAskResult] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [playlistDraft, setPlaylistDraft] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [attach, setAttach] = React.useState(null)
      const [attachName, setAttachName] = React.useState('')
      const [skinPrompt, setSkinPrompt] = React.useState('')
      const [skinDraft, setSkinDraft] = React.useState('')
      const [migrateTo, setMigrateTo] = React.useState('')
      const [storageConfirm, setStorageConfirm] = React.useState('')
      const [batchPurge, setBatchPurge] = React.useState(0)
      const fileRef = React.useRef(null)
      const flashTimer = React.useRef(0)
      const confirmTimer = React.useRef(0)
      const searchSeq = React.useRef(0)
      const skinTimer = React.useRef(0)
      const pendingSkin = React.useRef(null)
      const askPoll = React.useRef(0)
      const [rect, setRect] = React.useState(() => loadPanelRect())
      const dragRef = React.useRef(null)

      // 拖动与缩放：pointermove 挂 window 上，松手才落盘，避免拖拽期间狂写 localStorage
      React.useEffect(() => {
        const move = (event) => {
          const drag = dragRef.current
          if (!drag) return
          // 在窗口外松手收不到 pointerup：按着键的状态才是真相，没按着就收工。
          if (event.buttons === 0) { dragRef.current = null; return }
          const dx = event.clientX - drag.x0
          const dy = event.clientY - drag.y0
          if (drag.mode === 'move') {
            setRect(clampRect({ x: drag.rect.x + dx, y: drag.rect.y + dy, w: drag.rect.w, h: drag.rect.h }))
          } else {
            setRect(clampRect({ x: drag.rect.x, y: drag.rect.y, w: drag.rect.w + dx, h: drag.rect.h + dy }))
          }
        }
        const up = () => {
          if (!dragRef.current) return
          dragRef.current = null
          setRect((value) => { savePanelRect(value); return value })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
        }
      }, [])

      // 窗口变小/换屏后把面板拉回可视区：否则它会整块留在屏幕外，连「复位」都点不到。
      React.useEffect(() => {
        const onResize = () => setRect((value) => clampRect(value))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const startPanelDrag = (event, mode) => {
        if (event.button !== 0) return
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('button,input,select')) return
        event.preventDefault()
        dragRef.current = { mode, x0: event.clientX, y0: event.clientY, rect }
      }

      const skin = { ...DEFAULT_SKIN, ...(state.settings.skin || {}) }
      const anim = skin.anim !== false && uiState.visible
      const shortcuts = state.settings.shortcuts || { global: {}, panel: {} }

      const tracks = React.useMemo(() => sortTracks(state.tracks, state.settings), [state.tracks, state.settings])
      const activePlaylist = playlistId ? state.playlists.find(item => item.id === playlistId) : null
      const visibleTracks = React.useMemo(() => {
        const needle = filter.trim().toLowerCase()
        let list = tracks
        if (playlistId === '__fav__') list = list.filter(track => track.fav)
        else if (activePlaylist) list = list.filter(track => (track.playlists || []).includes(activePlaylist.id))
        const kind = state.settings.kind || 'all'
        if (kind !== 'all') list = list.filter(track => track.kind === kind)
        if (needle) {
          list = list.filter(track => (track.title + ' ' + track.artist + ' ' + (track.tags || []).join(' ') + ' ' + track.category)
            .toLowerCase().includes(needle))
        }
        return list
      }, [tracks, playlistId, activePlaylist, state.settings.kind, filter])

      const pickedIds = Object.keys(picked).filter(id => picked[id])

      React.useEffect(() => {
        beacon('panel-mounted', { clientPanelOpen: ui.panelOpen ? 1 : 0, clientTracks: snapshot.tracks.length })
      }, [])

      React.useEffect(() => {
        if (!ui.panelOpen) return
        void syncState()
      }, [uiState.panelOpen])

      if (!uiState.panelOpen) return null

      const currentTrack = current.trackId ? state.tracks.find(track => track.id === current.trackId) : null
      const jobs = state.jobs.filter(job => job.status === 'queued' || job.status === 'running')
      const queueIds = visibleTracks.map(track => track.id)

      // 背景层：有图片就「压暗层 + 图片」，否则用模型/自定渐变；两者都没有就保持纯色玻璃。
      const bgUrl = skin.bgFile ? API + '/skin/bg?v=' + (skin.bgStamp || 0) : ''
      const dimColor = 'rgba(0,0,0,' + Math.max(0, Math.min(0.9, Number(skin.bgDim ?? 0.35))) + ')'
      const panelBackground = bgUrl
        ? 'linear-gradient(' + dimColor + ',' + dimColor + '), url("' + bgUrl + '")'
        : (skin.gradient || '')

      const flash = (text, kind) => {
        setMessage({ text, kind: kind || 'info' })
        // 后到的提示要能顶掉前一条：旧写法每条都排一个 3.4s 的清理定时器，
        // 第二条经常只闪了半秒就被第一条的定时器清掉。
        if (flashTimer.current) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => { flashTimer.current = 0; setMessage(null) }, 3400)
      }
      const patchSettings = async (patch, label) => {
        setSnapshot({ settings: { ...state.settings, ...patch } })
        try {
          await postJson(API + '/settings', { patch })
          if (label) flash(label)
        } catch (error) { flash('保存失败：' + error.message, 'error') }
      }
      const patchSkin = (patch) => patchSettings({ skin: { ...skin, ...patch } })
      // 滑杆/取色器是连续输入：本地立刻生效，落盘合并 300ms 防抖，一次拖动只发一个请求。
      const patchSkinLive = (patch) => {
        setSnapshot({ settings: { ...state.settings, skin: { ...skin, ...patch } } })
        pendingSkin.current = { ...(pendingSkin.current || {}), ...patch }
        if (skinTimer.current) window.clearTimeout(skinTimer.current)
        skinTimer.current = window.setTimeout(() => {
          skinTimer.current = 0
          const merged = pendingSkin.current || {}
          pendingSkin.current = null
          if (!Object.keys(merged).length) return
          void postJson(API + '/settings', { patch: { skin: merged } })
            .catch((error) => flash('皮肤保存失败：' + error.message, 'error'))
        }, 300)
      }

      const runBatch = async (action, extra, label) => {
        if (!pickedIds.length) return
        setBusy('batch')
        try {
          const data = await postJson(API + '/batch', { action, ids: pickedIds, ...(extra || {}) })
          await syncState()
          setPicked({})
          flash(label || ('已处理 ' + pickedIds.length + ' 首' + (data && data.updated ? '（' + data.updated + '）' : '')))
        } catch (error) { flash('批量失败：' + error.message, 'error') }
        finally { setBusy('') }
      }

      // 点＋不再是浮层（面板的 backdrop-filter 会裁掉 fixed 浮层），而是整块换成歌单目录
      const openAttachSheet = (event, extra) => {
        event.stopPropagation()
        setAttachName('')
        setPlaylistDraft(null)
        setAttach({ mode: 'batch', ids: [], ...(extra || {}) })
      }
      const attachIds = () => {
        if (!attach) return []
        if (attach.mode === 'batch') return attach.ids || []
        return attach.trackId ? [attach.trackId] : []
      }
      const inPlaylist = (trackId, playlistId) => {
        const track = state.tracks.find(item => item.id === trackId)
        return Boolean(track && (track.playlists || []).includes(playlistId))
      }
      const toggleAttach = async (playlist) => {
        const ids = attachIds()
        if (!ids.length || !playlist) return
        const all = ids.every(id => inPlaylist(id, playlist.id))
        try {
          await postJson(API + '/playlist', { action: all ? 'remove' : 'add', id: playlist.id, trackIds: ids })
          await syncState()
        } catch (error) { flash(error.message, 'error') }
      }
      const createAttachPlaylist = async () => {
        const name = attachName.trim()
        if (!name) return
        const ids = attachIds()
        try {
          const created = await postJson(API + '/playlist', { action: 'create', name })
          const id = created.playlist && created.playlist.id
          if (id && ids.length) await postJson(API + '/playlist', { action: 'add', id, trackIds: ids })
          setAttachName('')
          await syncState()
          flash('歌单「' + name + '」已建，加入 ' + ids.length + ' 个')
        } catch (error) { flash('建歌单失败：' + error.message, 'error') }
      }
      const importSkinImage = async (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        setBusy('skin')
        try {
          const dataUrl = await downscaleImage(file, 1600, 0.86)
          const data = await postJson(API + '/skin/upload', { dataUrl })
          setSnapshot({ settings: { ...state.settings, skin: data.skin } })
          await syncState()
          flash('背景图已应用')
        } catch (error) { flash('导入失败：' + error.message, 'error') }
        finally { setBusy('') }
      }
      const clearSkinImage = async () => {
        try {
          await postJson(API + '/skin/clear', {})
          await syncState()
          flash('背景图已移除')
        } catch (error) { flash(error.message, 'error') }
      }
      const designSkin = async () => {
        const text = skinPrompt.trim()
        if (!text) return
        setBusy('design')
        const ok = await sendToModel(text, 'skin')
        setBusy('')
        if (ok) { flash('已交给模型设计，配色会直接落到面板上'); setSkinPrompt('') }
      }
      const migrateStorage = async (to) => {
        const target = String(to || '').trim()
        if (!target) return
        // 确认态要绑定到具体目标：旧写法是全局布尔，改个目录再点就直接开搬。
        if (storageConfirm !== target) {
          setStorageConfirm(target)
          if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
          confirmTimer.current = window.setTimeout(() => { confirmTimer.current = 0; setStorageConfirm('') }, 4000)
          return
        }
        setStorageConfirm('')
        setBusy('migrate')
        try {
          const data = await postJson(API + '/migrate', { to: target })
          await syncState()
          flash('已迁移 ' + data.moved + ' 个到 ' + data.to + (data.failed && data.failed.length ? '，' + data.failed.length + ' 个失败' : ''))
        } catch (error) { flash('迁移失败：' + error.message, 'error') }
        finally { setBusy('') }
      }

      const doSearch = async () => {
        const keyword = query.trim()
        if (!keyword) return
        // 序号守卫：先发的请求后到时不能覆盖新结果。
        const seq = (searchSeq.current += 1)
        setSearching(true)
        setMessage(null)
        try {
          const data = await getJson(API + '/search?q=' + encodeURIComponent(keyword) + '&limit=15')
          if (seq !== searchSeq.current) return
          const items = (data && data.items) || []
          setResults(items)
          if (!items.length) flash('B 站没搜到，换个词试试', 'error')
        } catch (error) {
          flash('搜索失败：' + error.message, 'error')
        } finally { setSearching(false) }
      }

      const downloadItems = async (items, kind) => {
        if (!items.length) return
        setBusy('download')
        try {
          await postJson(API + '/download', {
            items: items.map(item => ({ ...item, kind })),
            playlistId: activePlaylist ? activePlaylist.id : undefined,
          })
          flash('已开始下载 ' + items.length + ' 个' + (kind === 'video' ? '视频' : '音频') + '，后台进行中…')
          setSelected({})
          void syncState()
        } catch (error) {
          flash('下载请求失败：' + error.message, 'error')
        } finally { setBusy('') }
      }

      const currentSessionId = () => {
        if (sessionId) return sessionId
        try {
          const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : null
          const list = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null
          const rows = list && list.byId ? Object.values(list.byId) : []
          const main = rows.find(row => row && row.retainedBy && row.retainedBy.mainView > 0)
          return (main && main.id) || ''
        } catch { return '' }
      }

      const sendToModel = async (text, mode) => {
        // 一次性代理不需要当前会话当上下文，但仍要借它当「谁在委派」：
        // 宿主用它校验父 agent 是否在线。
        const target = currentSessionId()
        const controller = new AbortController()
        // 宿主自己最多等 150 秒，这里再宽一点；没有超时的话按钮会永久停在「发送中…」。
        const timer = window.setTimeout(() => controller.abort(), 200000)
        try {
          const data = await postJson(API + '/ask', { prompt: text, sessionId: target, mode: mode || askMode, think }, { signal: controller.signal })
          return data || {}
        } catch (error) {
          flash(controller.signal.aborted ? '模型一直没回话，稍后再试一次' : '失败：' + error.message, 'error')
          return null
        } finally { window.clearTimeout(timer) }
      }

      // 点歌可能超过宿主等待窗口：这时结果还在内存里，靠 /api/ask/status 补上。
      const pollAsk = (sessionId, promptText) => {
        if (!sessionId || askPoll.current) return
        let tries = 0
        askPoll.current = window.setInterval(async () => {
          tries += 1
          if (tries > 100) { window.clearInterval(askPoll.current); askPoll.current = 0; return }
          try {
            const data = await getJson(API + '/ask/status?id=' + encodeURIComponent(sessionId))
            const job = data && data.job
            if (!job) return
            if (job.status === 'running' || job.status === 'pending') return
            window.clearInterval(askPoll.current)
            askPoll.current = 0
            setAskResult({ prompt: promptText, answer: job.answer || '', pending: false, sessionId, at: Date.now() })
            void syncState()
          } catch { /* 继续等 */ }
        }, 3000)
      }

      const askModel = async () => {
        const text = prompt.trim()
        if (!text) return
        setBusy('ask')
        setAskResult(null)
        const data = await sendToModel(text, askMode)
        setBusy('')
        if (!data) return
        if (data.fresh === false) {
          flash(think ? '已交给模型，它会先推理再动手。回对话里看过程。' : '已交给模型处理。')
          setPrompt('')
          return
        }
        setAskResult({
          prompt: text,
          answer: data.answer || '',
          pending: Boolean(data.pending),
          sessionId: data.sessionId || '',
          at: Date.now(),
        })
        if (data.pending) pollAsk(data.sessionId, text)
        else setPrompt('')
        void syncState()
      }

      const toggleFav = async (track) => {
        try {
          await postJson(API + '/track', { action: 'update', id: track.id, patch: { fav: !track.fav } })
          void syncState()
        } catch (error) { flash(error.message, 'error') }
      }
      const removeTrack = async (track) => {
        try {
          await postJson(API + '/track', { action: 'remove', id: track.id })
          if (current.trackId === track.id) { pause(); setPlayer({ trackId: '' }) }
          void syncState()
          flash('已从曲库移除（文件还在硬盘上）')
        } catch (error) { flash(error.message, 'error') }
      }
      const rescan = async () => {
        setBusy('scan')
        try {
          const data = await postJson(API + '/scan', {})
          flash('扫描完成，新增 ' + ((data.added && data.added.length) || 0) + ' 个')
          void syncState()
        } catch (error) { flash('扫描失败：' + error.message, 'error') }
        finally { setBusy('') }
      }
      // Electron 里没有 window.prompt，歌单的新建/改名一律用面板内的行内输入框。
      const submitPlaylistDraft = async () => {
        const draft = playlistDraft
        if (!draft || !draft.value.trim()) { setPlaylistDraft(null); return }
        const name = draft.value.trim()
        try {
          if (draft.mode === 'create') {
            const data = await postJson(API + '/playlist', { action: 'create', name })
            await syncState()
            if (data.playlist) setPlaylistId(data.playlist.id)
            flash('歌单「' + name + '」建好了')
          } else if (activePlaylist) {
            await postJson(API + '/playlist', { action: 'rename', id: activePlaylist.id, name })
            await syncState()
            flash('已改名')
          }
          setPlaylistDraft(null)
        } catch (error) { flash('操作失败：' + error.message, 'error') }
      }
      const removePlaylist = async () => {
        if (!activePlaylist) return
        if (!confirmDelete) { setConfirmDelete(true); window.setTimeout(() => setConfirmDelete(false), 4000); return }
        setConfirmDelete(false)
        try {
          await postJson(API + '/playlist', { action: 'delete', id: activePlaylist.id })
          setPlaylistId('')
          await syncState()
          flash('歌单已删（曲目本身没删）')
        } catch (error) { flash('删除失败：' + error.message, 'error') }
      }
      const saveShortcut = (scope, action) => setUi({ recording: { scope, action } })
      const clearShortcut = (scope, action) => {
        const next = { global: { ...shortcuts.global }, panel: { ...shortcuts.panel } }
        delete next[scope][action]
        saveShortcuts(next)
      }
      const resetShortcuts = async () => {
        try {
          const data = await postJson(API + '/shortcuts/reset', {})
          setSnapshot({ settings: { ...state.settings, shortcuts: data.shortcuts } })
          flash('快捷键已恢复默认')
        } catch (error) { flash('重置失败：' + error.message, 'error') }
      }

      // ── 歌单目录（点＋后整块换成这个） ─────────────────────────────
      const renderAttach = () => {
        const ids = attachIds()
        const target = attach && attach.mode === 'track'
          ? state.tracks.find(item => item.id === attach.trackId)
          : null
        return h('div', null,
          h('div', { className: 'mp-toolbar' },
            h('span', {
              style: {
                flex: 1, fontSize: '11.5px', opacity: '.75', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, target ? '《' + target.title + '》' : '已选 ' + ids.length + ' 个'),
            h('button', { type: 'button', className: 'mp-btn', onClick: () => setAttach(null) }, '完成')),
          h('div', { className: 'mp-hint' }, '点一行就是加入/移出；勾着的就是这首已经在的歌单。'),
          state.playlists.length
            ? state.playlists.map(playlist => {
              const checked = ids.length > 0 && ids.every(id => inPlaylist(id, playlist.id))
              const partial = !checked && ids.some(id => inPlaylist(id, playlist.id))
              return h('div', {
                key: playlist.id, className: 'mp-row', 'data-current': checked ? '1' : '0',
                onClick: () => void toggleAttach(playlist),
              },
                h('input', {
                  type: 'checkbox', className: 'mp-check', checked, readOnly: true,
                  ref: (element) => { if (element) element.indeterminate = partial },
                }),
                h('div', { className: 'mp-row-main' },
                  h('div', { className: 'mp-row-title' }, playlist.name),
                  h('div', { className: 'mp-row-sub' },
                    h('span', null, playlist.count + ' 首'),
                    checked ? h('span', { className: 'mp-pl' }, '已加入') : null)),
              )
            })
            : h('div', { className: 'mp-empty' }, '还没有歌单，在下面建一个。'),
          h('div', { className: 'mp-toolbar', style: { marginTop: '6px' } },
            h('input', {
              className: 'mp-input', placeholder: '新歌单名…', value: attachName,
              onChange: (event) => setAttachName(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void createAttachPlaylist() },
            }),
            h('button', {
              type: 'button', className: 'mp-btn mp-btn-primary',
              onClick: () => void createAttachPlaylist(),
            }, '建并加入')),
        )
      }

      // ── 曲库页 ─────────────────────────────────────────────────────
      const renderList = () => h('div', null,
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input', placeholder: '在曲库里筛…', value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          h('select', {
            className: 'mp-select', value: state.settings.sort || 'added',
            onChange: (event) => void patchSettings({ sort: event.target.value }),
          }, SORT_OPTIONS.map(option => h('option', { key: option.key, value: option.key }, option.label))),
          h('button', {
            type: 'button', className: 'mp-btn', title: state.settings.asc ? '当前升序' : '当前降序',
            onClick: () => void patchSettings({ asc: !state.settings.asc }),
          }, state.settings.asc ? '↑' : '↓'),
          h('button', {
            type: 'button', className: 'mp-btn', 'data-on': batchMode ? '1' : '0', title: '多选批量操作',
            onClick: () => { setBatchMode(!batchMode); setPicked({}) },
          }, '多选'),
        ),
        h('div', { className: 'mp-chips' },
          h('button', {
            type: 'button', className: 'mp-chip', 'data-on': !playlistId ? '1' : '0',
            onClick: () => setPlaylistId(''),
          }, '全部', h('small', null, state.tracks.length)),
          h('button', {
            type: 'button', className: 'mp-chip', 'data-on': playlistId === '__fav__' ? '1' : '0',
            onClick: () => setPlaylistId('__fav__'),
          }, '收藏', h('small', null, state.tracks.filter(track => track.fav).length)),
          state.playlists.map(playlist => h('button', {
            key: playlist.id, type: 'button', className: 'mp-chip', 'data-on': playlistId === playlist.id ? '1' : '0',
            onClick: () => setPlaylistId(playlist.id),
          }, playlist.name, h('small', null, playlist.count))),
          h('button', { type: 'button', className: 'mp-chip', onClick: () => setPlaylistDraft({ mode: 'create', value: '' }) }, '＋ 歌单'),
        ),
        playlistDraft ? h('div', {
          className: 'mp-toolbar',
          onPointerDown: (event) => event.stopPropagation(),
        },
          h('input', {
            className: 'mp-input', autoFocus: true,
            placeholder: playlistDraft.mode === 'create' ? '新歌单名…' : '新名字…',
            value: playlistDraft.value,
            onChange: (event) => setPlaylistDraft({ ...playlistDraft, value: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void submitPlaylistDraft()
              if (event.key === 'Escape') setPlaylistDraft(null)
            },
          }),
          h('button', { type: 'button', className: 'mp-btn mp-btn-primary', onClick: () => void submitPlaylistDraft() },
            playlistDraft.mode === 'create' ? '建' : '改'),
          h('button', { type: 'button', className: 'mp-btn', onClick: () => setPlaylistDraft(null) }, '取消'),
        ) : null,
        h('div', { className: 'mp-chips' },
          KIND_OPTIONS.map(option => h('button', {
            key: option.key, type: 'button', className: 'mp-chip',
            'data-on': (state.settings.kind || 'all') === option.key ? '1' : '0',
            onClick: () => void patchSettings({ kind: option.key }),
          }, option.label))),
        activePlaylist ? h('div', { className: 'mp-toolbar' },
          h('span', { style: { fontSize: '11px', opacity: '.6', flex: 1 } }, '歌单：' + activePlaylist.name + ' · ' + activePlaylist.count + ' 首'),
          h('button', {
            type: 'button', className: 'mp-btn',
            onClick: () => setPlaylistDraft({ mode: 'rename', value: activePlaylist.name }),
          }, '改名'),
          h('button', {
            type: 'button', className: 'mp-btn', 'data-on': confirmDelete ? '1' : '0',
            onClick: () => void removePlaylist(),
          }, confirmDelete ? '再点一次确认' : '删除歌单'),
        ) : null,
        batchMode && pickedIds.length
          ? h('div', { className: 'mp-batch' },
            h('span', null, '已选 ' + pickedIds.length),
            h('button', {
              type: 'button', className: 'mp-btn',
              onClick: (event) => openAttachSheet(event, { mode: 'batch', ids: pickedIds }),
            }, '加入歌单'),
            h('button', { type: 'button', className: 'mp-btn', onClick: () => void runBatch('favorite', { value: true }, '已收藏') }, '收藏'),
            h('button', { type: 'button', className: 'mp-btn', onClick: () => void runBatch('remove', {}, '已从曲库移除') }, '移除'),
            h('button', {
              type: 'button', className: 'mp-btn',
              'data-on': batchPurge ? '1' : '0',
              title: '连磁盘文件一起删，不可恢复',
              style: batchPurge ? { borderColor: '#ff6b6b', color: '#ffb3b3' } : undefined,
              onClick: () => {
                if (!batchPurge) {
                  // 删文件是不可恢复操作，必须先确认一次（旁边「移除」只摘索引）。
                  setBatchPurge(1)
                  if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
                  confirmTimer.current = window.setTimeout(() => { confirmTimer.current = 0; setBatchPurge(0) }, 4000)
                  return
                }
                setBatchPurge(0)
                void runBatch('remove', { deleteFile: true }, '已删除文件')
              },
            }, batchPurge ? '确认删 ' + pickedIds.length + ' 个文件' : '删文件'),
            h('button', { type: 'button', className: 'mp-btn', onClick: () => setPicked({}) }, '取消'),
          )
          : null,
        jobs.length ? h('div', { className: 'mp-jobs' }, jobs.slice(0, 4).map(job => h('div', { key: job.id, className: 'mp-job' },
          job.kind === 'video' ? h('span', { style: { display: 'grid', placeItems: 'center', flex: '0 0 11px' } }, filmIcon(10)) : h('span', { style: { flex: '0 0 8px' } }, '♪'),
          h('span', null, String(job.title || job.bvid).slice(0, 14)),
          h('span', { className: 'mp-job-bar' }, h('i', { style: { width: Math.round((job.progress || 0) * 100) + '%' } })),
          h('span', { style: { width: '54px', textAlign: 'right', fontSize: '10px', opacity: '.7' } }, job.phase || (Math.round((job.progress || 0) * 100) + '%')),
        ))) : null,
        visibleTracks.length
          ? visibleTracks.map((track, index) => h('div', {
            key: track.id, className: 'mp-row',
            role: 'button',
            tabIndex: 0,
            'aria-current': track.id === current.trackId ? 'true' : undefined,
            'aria-label': (track.kind === 'video' ? '视频' : '音频') + '：' + track.title + (track.artist ? '，' + track.artist : ''),
            'data-current': track.id === current.trackId ? '1' : '0',
            'data-picked': picked[track.id] ? '1' : '0',
            onClick: () => {
              if (batchMode) { setPicked({ ...picked, [track.id]: !picked[track.id] }); return }
              playTrack(track, queueIds)
            },
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              if (event.target !== event.currentTarget) return
              event.preventDefault()
              if (batchMode) { setPicked({ ...picked, [track.id]: !picked[track.id] }); return }
              playTrack(track, queueIds)
            },
          },
            batchMode
              ? h('input', {
                type: 'checkbox', className: 'mp-check', checked: Boolean(picked[track.id]),
                onChange: (event) => setPicked({ ...picked, [track.id]: event.target.checked }),
                onClick: (event) => event.stopPropagation(),
              })
              : h('span', { className: 'mp-row-idx' }, track.id === current.trackId && current.playing ? '▶' : String(index + 1)),
            h('span', { className: 'mp-row-kind', title: track.kind === 'video' ? '视频' : '音频' },
              track.kind === 'video' ? filmIcon(12) : '♪'),
            h('div', { className: 'mp-row-main' },
              h('div', { className: 'mp-row-title' }, track.title),
              h('div', { className: 'mp-row-sub' },
                track.artist ? h('span', null, track.artist) : null,
                h('span', null, track.duration ? fmtTime(track.duration) : '—'),
                (track.playlists || []).slice(0, 2).map(id => {
                  const playlist = state.playlists.find(item => item.id === id)
                  return playlist ? h('span', { key: id, className: 'mp-pl' }, '#' + playlist.name) : null
                }),
                track.kind === 'video' && track.height ? h('span', null, track.height + 'p') : null,
              )),
            h('div', { className: 'mp-row-act' },
              h('button', {
                type: 'button', title: '加入歌单', onClick: (event) => openAttachSheet(event, { mode: 'track', trackId: track.id }),
              }, '＋'),
              h('button', {
                type: 'button', title: track.fav ? '取消收藏' : '收藏', 'data-on': track.fav ? '1' : '0',
                onClick: (event) => { event.stopPropagation(); void toggleFav(track) },
              }, '★'),
              h('button', {
                type: 'button', title: '从曲库移除',
                onClick: (event) => { event.stopPropagation(); void removeTrack(track) },
              }, '✕'),
            ),
          ))
          : h('div', { className: 'mp-empty' },
            state.ready ? (playlistId ? '这个歌单还是空的。' : '曲库还是空的。') : '正在读曲库…',
            h('br'),
            batchMode ? '勾选几首，用上方的批量条处理。' : '去「搜索」下新的，或者「点歌」让模型帮你找。'),
      )

      // ── 搜索页 ─────────────────────────────────────────────────────
      const renderSearch = () => h('div', null,
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input', placeholder: '搜 B 站：歌名 / UP 主 / 曲风 / 梗',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void doSearch() },
          }),
          h('select', {
            className: 'mp-select', value: searchKind,
            onChange: (event) => setSearchKind(event.target.value),
          },
            h('option', { value: 'audio' }, '下音频'),
            h('option', { value: 'video' }, '下视频')),
          h('button', {
            type: 'button', className: 'mp-btn mp-btn-primary', disabled: searching,
            onClick: () => void doSearch(),
          }, searching ? '搜…' : '搜索'),
        ),
        results.length ? h('div', { className: 'mp-toolbar' },
          h('span', { style: { fontSize: '11px', opacity: '.6', flex: 1 } }, '共 ' + results.length + ' 条'),
          h('button', {
            type: 'button', className: 'mp-btn mp-btn-primary', disabled: busy === 'download',
            onClick: () => {
              const pickedItems = results.filter(item => selected[item.bvid])
              void downloadItems(pickedItems.map(item => ({ bvid: item.bvid, title: item.title, artist: item.author })), searchKind)
            },
          }, '下选中 ' + results.filter(item => selected[item.bvid]).length),
          h('button', {
            type: 'button', className: 'mp-btn', disabled: busy === 'download',
            onClick: () => void downloadItems(results.map(item => ({ bvid: item.bvid, title: item.title, artist: item.author })), searchKind),
          }, '全下'),
        ) : null,
        results.length
          ? results.map(item => h('div', { key: item.bvid, className: 'mp-res' },
            h('input', {
              type: 'checkbox', className: 'mp-check', checked: Boolean(selected[item.bvid]),
              onChange: (event) => setSelected({ ...selected, [item.bvid]: event.target.checked }),
            }),
            item.cover
              ? h('img', { src: API + '/cover?u=' + encodeURIComponent(item.cover), alt: '', loading: 'lazy' })
              : h('span', { style: { width: '44px', flex: '0 0 44px' } }),
            h('div', { className: 'mp-res-main' },
              h('div', { className: 'mp-res-title' }, item.title),
              h('div', { className: 'mp-res-sub' }, (item.author || '') + ' · ' + fmtTime(item.duration) + ' · ' + item.bvid),
            ),
            h('button', {
              type: 'button', className: 'mp-btn',
              onClick: () => void downloadItems([{ bvid: item.bvid, title: item.title, artist: item.author }], searchKind),
            }, searchKind === 'video' ? '下视频' : '下音频'),
          ))
          : h('div', { className: 'mp-empty' }, '输入关键词回车。搜走 B 站接口，下载走后台，不弹唧唧窗口。'),
      )

      // ── 点歌页 ─────────────────────────────────────────────────────
      const renderAsk = () => h('div', null,
        h('div', { className: 'mp-chips' }, ASK_MODES.map(mode => h('button', {
          key: mode.key, type: 'button', className: 'mp-chip', 'data-on': askMode === mode.key ? '1' : '0',
          title: mode.hint,
          onClick: () => { setAskMode(mode.key); void patchSettings({ askMode: mode.key }) },
        }, mode.label))),
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input', placeholder: askMode === 'organize' ? '比如：按语种把曲库整理成歌单' : askMode === 'recommend' ? '比如：放点能嗨的' : '比如：我想听鸡哥的歌',
            value: prompt,
            onChange: (event) => setPrompt(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void askModel() },
          }),
          h('button', {
            type: 'button', className: 'mp-btn mp-btn-primary', disabled: busy === 'ask',
            onClick: () => void askModel(),
          }, busy === 'ask' ? '发送中…' : '交给模型'),
        ),
        h('div', { className: 'mp-toolbar' },
          h('button', {
            type: 'button', className: 'mp-btn', 'data-on': think ? '1' : '0', title: '先分步推理再动手',
            onClick: () => { setThink(!think); void patchSettings({ askThink: !think }) },
          }, '深度思考'),
          h('span', { style: { fontSize: '10.5px', opacity: '.55', flex: 1 } },
            think ? '模型会先推理：搜什么词、挑哪几首、怎么分类。' : '直接执行，不要求推理过程。'),
        ),
        h('div', { className: 'mp-chips' }, (PROMPT_CHIPS[askMode] || PROMPT_CHIPS.discover).map(chip => h('button', {
          key: chip.label, type: 'button', className: 'mp-chip',
          onClick: () => { setPrompt(chip.text) },
        }, chip.label))),
        busy === 'ask' ? h('div', { className: 'mp-msg' }, h('span', { className: 'mp-think' },
          h('i', null), h('i', null), h('i', null), h('span', null, '一次性搜索代理正在跑…'))) : null,
        askResult ? h('div', {
          style: {
            marginTop: '8px', padding: '8px 10px', borderRadius: '8px',
            background: 'rgba(84,184,255,.12)', border: '1px solid rgba(84,184,255,.35)',
            fontSize: '11.5px', lineHeight: '1.55', whiteSpace: 'pre-wrap',
          },
        },
          h('div', { style: { opacity: '.6', marginBottom: '4px' } },
            '代理回话 · ' + (askResult.sessionId ? askResult.sessionId.slice(-8) : '本地')),
          h('div', null, askResult.answer || (askResult.pending ? '还在跑，稍后自己在会话树里看结果。' : '（代理没有回话）')),
        ) : null,
        h('div', { className: 'mp-hint' },
          '每次点歌都单开一个一次性代理：不带聊天历史、只给 music_* 六个工具、'
          + '思考档位默认 low，一般 2~20 秒回话。代理会话挂在当前对话的树下面，当记录用。'),
      )

      // ── 外观页 ─────────────────────────────────────────────────────
      const renderSkin = () => h('div', null,
        h('div', { className: 'mp-sec' }, '皮肤'),
        h('div', { className: 'mp-skins' }, Object.entries(SKIN_PRESETS).map(([key, preset]) => h('button', {
          key, type: 'button', className: 'mp-skin', 'data-on': skin.preset === key ? '1' : '0',
          onClick: () => void patchSkin({ preset: key, accent: preset.accent, surface: preset.surface, text: preset.text }),
        },
          h('span', { className: 'mp-dot', style: { background: 'linear-gradient(90deg,' + preset.accent + ',' + preset.surface + ')' } }),
          h('span', null, preset.label),
        ))),
        h('div', { className: 'mp-field' },
          h('label', null, '主色'),
          h('input', {
            className: 'mp-color', type: 'color', value: skin.accent,
            onChange: (event) => patchSkinLive({ accent: event.target.value, preset: 'custom' }),
          }),
          h('label', null, '底色'),
          h('input', {
            className: 'mp-color', type: 'color', value: skin.surface,
            onChange: (event) => patchSkinLive({ surface: event.target.value, preset: 'custom' }),
          }),
        ),
        h('div', { className: 'mp-field' },
          h('label', null, '模糊'),
          h('input', {
            className: 'mp-bar', type: 'range', min: 0, max: 30, value: skin.blur,
            style: { '--mp-pct': (skin.blur / 30 * 100) + '%' },
            onChange: (event) => patchSkinLive({ blur: Number(event.target.value) }),
          }),
        ),
        h('div', { className: 'mp-field' },
          h('label', null, '不透明'),
          h('input', {
            className: 'mp-bar', type: 'range', min: 40, max: 100, value: Math.round(skin.opacity * 100),
            style: { '--mp-pct': ((skin.opacity * 100 - 40) / 60 * 100) + '%' },
            onChange: (event) => patchSkinLive({ opacity: Number(event.target.value) / 100 }),
          }),
        ),
        h('div', { className: 'mp-field' },
          h('label', null, '圆角'),
          h('input', {
            className: 'mp-bar', type: 'range', min: 6, max: 28, value: skin.radius,
            style: { '--mp-pct': ((skin.radius - 6) / 22 * 100) + '%' },
            onChange: (event) => patchSkinLive({ radius: Number(event.target.value) }),
          }),
        ),
        h('div', { className: 'mp-field' },
          h('label', null, '氛围光'),
          h('button', { type: 'button', className: 'mp-btn', onClick: () => void patchSkin({ glow: !skin.glow }) },
            skin.glow ? '开' : '关'),
          h('label', null, '动画'),
          h('button', { type: 'button', className: 'mp-btn', onClick: () => void patchSkin({ anim: !skin.anim }) },
            skin.anim ? '开' : '关'),
        ),
        h('div', { className: 'mp-sec' }, '自定义外观'),
        h('div', { className: 'mp-field' },
          h('button', {
            type: 'button', className: 'mp-btn', disabled: busy === 'skin',
            onClick: () => { if (fileRef.current) fileRef.current.click() },
          }, skin.bgFile ? '换背景图' : '导入背景图'),
          h('button', {
            type: 'button', className: 'mp-btn', disabled: !skin.bgFile || busy === 'skin',
            onClick: () => void clearSkinImage(),
          }, '移除'),
          h('input', {
            ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp',
            style: { display: 'none' },
            onChange: (event) => void importSkinImage(event),
          }),
        ),
        skin.bgFile ? h('div', { className: 'mp-field' },
          h('label', null, '压暗'),
          h('input', {
            className: 'mp-bar', type: 'range', min: 0, max: 85, value: Math.round((skin.bgDim ?? 0.35) * 100),
            style: { '--mp-pct': (((skin.bgDim ?? 0.35) * 100) / 85 * 100) + '%' },
            onChange: (event) => patchSkinLive({ bgDim: Number(event.target.value) / 100 }),
          }),
        ) : null,
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input',
            placeholder: skin.gradient ? '当前：' + skin.gradient.slice(0, 46) : 'CSS 渐变，如 linear-gradient(140deg,#0a0f1a,#1b2b46)',
            value: skinDraft, onChange: (event) => setSkinDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              void patchSkin({ gradient: skinDraft.trim(), preset: 'custom', presetName: '自定义渐变' })
            },
          }),
          h('button', {
            type: 'button', className: 'mp-btn',
            onClick: () => void patchSkin({ gradient: skinDraft.trim(), preset: 'custom', presetName: '自定义渐变' }),
          }, '用这个渐变'),
        ),
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input', placeholder: '描述风格：赛博霓虹 / 深海寂静 / 宣纸墨色…',
            value: skinPrompt, onChange: (event) => setSkinPrompt(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void designSkin() },
          }),
          h('button', {
            type: 'button', className: 'mp-btn mp-btn-primary', disabled: busy === 'design' || !skinPrompt.trim(),
            onClick: () => void designSkin(),
          }, busy === 'design' ? '已交付…' : '让模型设计'),
        ),
        h('div', { className: 'mp-hint' },
          '模型会自己配色并调用 music_skin 落盘，面板下一拍就换；',
          '已导入的图片不会被模型覆盖，只在没有图片时用渐变色。'),

        h('div', { className: 'mp-sec' }, '面板'),
        h('div', { className: 'mp-field' },
          h('span', { style: { fontSize: '10.5px', opacity: '.62', flex: 1 } },
            '拖标题栏移动、拖右下角改大小，位置会记住'),
          h('button', {
            type: 'button', className: 'mp-btn',
            onClick: () => {
              const next = defaultPanelRect()
              setRect(next)
              savePanelRect(next)
              flash('面板位置与大小已复位')
            },
          }, '复位'),
        ),

        h('div', { className: 'mp-sec' }, '存储位置'),
        h('div', { className: 'mp-field' }, h('label', null, '当前'),
          h('span', { style: { fontSize: '10.5px', opacity: '.62', wordBreak: 'break-all' } }, state.paths.downloadDir || '—')),
        h('div', { className: 'mp-toolbar' },
          h('button', {
            type: 'button', className: 'mp-btn', disabled: busy === 'migrate',
            'data-on': storageConfirm === 'E:\\DshMusic' ? '1' : '0',
            onClick: () => void migrateStorage('E:\\DshMusic'),
          }, busy === 'migrate' ? '迁移中…' : (storageConfirm === 'E:\\DshMusic' ? '再点一次确认' : '迁到 E:\\DshMusic')),
          h('input', {
            className: 'mp-input', placeholder: '或自定目录，例如 E:\\Music',
            value: migrateTo, onChange: (event) => setMigrateTo(event.target.value),
          }),
          h('button', {
            type: 'button', className: 'mp-btn', disabled: !migrateTo.trim() || busy === 'migrate',
            'data-on': storageConfirm !== '' && storageConfirm === migrateTo.trim() ? '1' : '0',
            onClick: () => void migrateStorage(migrateTo),
          }, storageConfirm !== '' && storageConfirm === migrateTo.trim() ? '再点一次确认' : '迁过去'),
        ),
        h('div', { className: 'mp-hint' }, '迁移会把文件挪过去并同步索引，跨盘用复制+删除；同名文件会跳过并在提示里报数量。'),

        h('div', { className: 'mp-sec' }, '下载与视频'),
        h('div', { className: 'mp-field' }, h('label', null, '目录'),
          h('span', { style: { fontSize: '10.5px', opacity: '.6', wordBreak: 'break-all' } }, state.paths.downloadDir || '—')),
        h('div', { className: 'mp-field' }, h('label', null, '唧唧'),
          h('span', { style: { fontSize: '10.5px', opacity: '.6', wordBreak: 'break-all' } },
            state.paths.ffmpegReady ? 'ffmpeg 就绪 · ' + (state.paths.jijidownDir || '未找到下载目录') : '未找到唧唧DOWN 的 ffmpeg')),
        h('div', { className: 'mp-field' },
          h('button', { type: 'button', className: 'mp-btn', disabled: busy === 'scan', onClick: () => void rescan() },
            busy === 'scan' ? '扫描中…' : '重扫目录'),
          h('button', {
            type: 'button', className: 'mp-btn',
            onClick: () => void patchSettings(
              { scanJijidown: !state.settings.scanJijidown },
              '唧唧目录 ' + (state.settings.scanJijidown ? '已关' : '已跟'),
            ),
          }, state.settings.scanJijidown ? '唧唧目录：跟' : '唧唧目录：不跟'),
        ),
        h('div', { className: 'mp-field' },
          h('label', null, '视频窗'),
          h('button', {
            type: 'button', className: 'mp-btn', 'data-on': state.settings.autoVideoWindow ? '1' : '0',
            onClick: () => void patchSettings({ autoVideoWindow: !state.settings.autoVideoWindow }),
          }, state.settings.autoVideoWindow ? '播视频自动开' : '手动开'),
          h('button', {
            type: 'button', className: 'mp-btn',
            onClick: () => setVideoOpen(!ui.videoOpen),
          }, ui.videoOpen ? '收起视频窗' : '打开视频窗'),
        ),
        h('div', { className: 'mp-sec' }, '数据'),
        h('div', { className: 'mp-field' }, h('label', null, '曲库'),
          h('span', { style: { fontSize: '10.5px', opacity: '.6' } },
            state.tracks.length + ' 个 · 音频 ' + state.tracks.filter(track => track.kind !== 'video').length
            + ' · 视频 ' + state.tracks.filter(track => track.kind === 'video').length
            + ' · 歌单 ' + state.playlists.length)),
      )

      // ── 快捷键页 ───────────────────────────────────────────────────
      const renderKeys = () => {
        const groups = [
          { scope: 'global', title: '全局（页面任意处、非输入框）', actions: [
            ['playPause', '播放 / 暂停'], ['next', '下一首'], ['prev', '上一首'],
            ['volumeUp', '音量 +'], ['volumeDown', '音量 -'], ['mute', '静音'],
            ['togglePanel', '展开 / 收起面板'], ['videoWindow', '视频窗开关'], ['fullscreen', '视频窗全屏 / 退出'],
          ] },
          { scope: 'panel', title: '面板内（面板打开且不在输入框）', actions: [
            ['playPause', '播放 / 暂停'], ['seekForward', '快进 5 秒'], ['seekBack', '快退 5 秒'],
            ['volumeUp', '音量 +'], ['volumeDown', '音量 -'], ['mute', '静音'], ['close', '收起面板'],
            ['fullscreen', '视频窗全屏 / 退出'],
          ] },
        ]
        return h('div', null,
          h('div', { className: 'mp-hint' }, '点右侧按键按钮，然后按你想绑的键；按 Esc / Tab 取消录制。'),
          groups.map(group => h('div', { key: group.scope },
            h('div', { className: 'mp-sec' }, group.title),
            group.actions.map(([action, label]) => {
              const recordingThis = uiState.recording && uiState.recording.scope === group.scope && uiState.recording.action === action
              const binding = (shortcuts[group.scope] || {})[action]
              return h('div', { key: action, className: 'mp-field' },
                h('label', null, label),
                h('button', {
                  type: 'button', className: 'mp-btn',
                  'data-on': recordingThis ? '1' : '0',
                  style: { flex: 1, textAlign: 'left' },
                  onClick: () => saveShortcut(group.scope, action),
                }, recordingThis ? '按下新键位…' : (binding ? prettyCombo(binding) : '未绑定')),
                h('button', { type: 'button', className: 'mp-btn', onClick: () => clearShortcut(group.scope, action) }, '清'),
              )
            }),
          )),
          h('div', { className: 'mp-toolbar' },
            h('button', { type: 'button', className: 'mp-btn', onClick: () => void resetShortcuts() }, '恢复默认'),
            h('span', { style: { fontSize: '10.5px', opacity: '.55', flex: 1 } },
              '媒体键（播放/暂停、上一首、下一首）始终可用。'),
          ),
        )
      }

      return h('div', {
        'data-mp-panel': '',
        'data-mp-anim': anim ? 'on' : 'off',
        'data-mp-glow': skin.glow ? '1' : '0',
        style: {
          left: rect.x + 'px',
          top: rect.y + 'px',
          width: rect.w + 'px',
          height: rect.h + 'px',
          '--mp-accent': skin.accent,
          '--mp-surface': skin.surface,
          '--mp-text': skin.text,
          '--mp-blur': skin.blur + 'px',
          '--mp-opacity': String(skin.opacity),
          '--mp-radius': skin.radius + 'px',
          ...(panelBackground
            ? { backgroundImage: panelBackground, backgroundSize: 'cover', backgroundPosition: 'center' }
            : {}),
        },
        onPointerDown: () => { if (playlistDraft) setPlaylistDraft(null) },
      },
        h('div', {
          className: 'mp-head',
          onPointerDown: (event) => startPanelDrag(event, 'move'),
          title: '按住这里可以拖动面板',
        },
          currentTrack && currentTrack.coverUrl
            ? h('img', { className: 'mp-cover', src: currentTrack.coverUrl, alt: '', loading: 'lazy' })
            : h('div', { className: 'mp-cover mp-cover-fallback' }, currentTrack ? String(currentTrack.title).slice(0, 1) : '♪'),
          h('div', { className: 'mp-head-main' },
            h('div', { className: 'mp-title' }, currentTrack ? currentTrack.title : '还没选歌'),
            h('div', { className: 'mp-artist' },
              currentTrack
                ? (currentTrack.artist || '未知 UP 主') + ' · 共 ' + state.tracks.length + ' 个'
                : '选一个，或者让模型帮你找'),
            h('div', { className: 'mp-tags' },
              currentTrack && currentTrack.kind === 'video' ? h('span', { className: 'mp-tag', 'data-kind': 'video' }, '视频') : null,
              currentTrack ? (currentTrack.tags || []).slice(0, 4).map(tag => h('span', { key: tag, className: 'mp-tag' }, tag)) : null,
              currentTrack && currentTrack.category ? h('span', { className: 'mp-tag' }, currentTrack.category) : null),
          ),
          h('button', {
            type: 'button', className: 'mp-close', title: '收起',
            onClick: () => setUi({ panelOpen: false, recording: null }),
          }, '✕'),
        ),
        h('div', { className: 'mp-progress' },
          progressBar(position, mediaDuration(), seek),
          h('div', { className: 'mp-times' },
            h('span', null, fmtTime(position, mediaDuration() > 0 && mediaDuration() < 10)),
            current.streaming
              ? h('span', { title: '文件超过 blob 阈值，走 HTTP 流式播放，拖动可能不准', style: { opacity: '.8' } }, '流式 · 可能拖不准')
              : null,
            h('span', null, mediaDuration() > 0 ? fmtTime(mediaDuration(), mediaDuration() < 10) : '--:--')),
        ),
        h('div', { className: 'mp-transport' },
          h('button', {
            type: 'button', className: 'mp-ctrl', title: '随机', 'data-active': current.shuffle ? '1' : '0',
            onClick: () => { setPlayer({ shuffle: !current.shuffle }); scheduleReport() },
          }, icon(ICON.shuffle, 14)),
          h('button', { type: 'button', className: 'mp-ctrl', title: '上一首', disabled: !state.tracks.length, onClick: () => step(-1) }, icon(ICON.prev, 16)),
          h('button', {
            type: 'button', className: 'mp-ctrl mp-play', title: current.playing ? '暂停' : '播放',
            disabled: !state.tracks.length, onClick: () => toggle(),
          }, h('span', { key: current.playing ? 'p' : 's', className: 'mp-flip' },
            icon(current.playing ? ICON.pause : ICON.play, 17))),
          h('button', { type: 'button', className: 'mp-ctrl', title: '下一首', disabled: !state.tracks.length, onClick: () => step(1) }, icon(ICON.next, 16)),
          h('button', {
            type: 'button', className: 'mp-ctrl',
            title: '循环：' + ({ off: '不循环', all: '列表循环', one: '单曲循环' }[current.repeat] || '列表循环'),
            'data-active': current.repeat !== 'off' ? '1' : '0',
            onClick: () => {
              const next = current.repeat === 'all' ? 'one' : current.repeat === 'one' ? 'off' : 'all'
              setPlayer({ repeat: next })
              scheduleReport()
            },
          }, icon(current.repeat === 'one' ? ICON.repeatOne : ICON.repeat, 14)),
          h('button', {
            type: 'button', className: 'mp-ctrl', title: '视频窗', 'data-active': ui.videoOpen ? '1' : '0',
            onClick: () => setVideoOpen(!ui.videoOpen),
          }, icon(ICON.video, 15)),
          h('div', { className: 'mp-vol' },
            h('button', {
              type: 'button', className: 'mp-ctrl', title: current.muted ? '取消静音' : '静音',
              onClick: () => toggleMute(),
            }, icon(current.muted || current.volume === 0 ? ICON.mute : ICON.volume, 15)),
            h('input', {
              className: 'mp-bar', type: 'range', min: 0, max: 100,
              value: Math.round((current.muted ? 0 : current.volume) * 100),
              style: { '--mp-pct': Math.round((current.muted ? 0 : current.volume) * 100) + '%' },
              onChange: (event) => setVolume(Number(event.target.value) / 100),
            }),
          ),
        ),
        h('div', { className: 'mp-tabs' },
          h('button', { type: 'button', className: 'mp-tab', 'data-on': tab === 'list' && !attach ? '1' : '0', onClick: () => { setTab('list'); setAttach(null) } }, '曲库'),
          h('button', { type: 'button', className: 'mp-tab', 'data-on': tab === 'search' ? '1' : '0', onClick: () => { setTab('search'); setAttach(null) } }, '搜索'),
          h('button', { type: 'button', className: 'mp-tab', 'data-on': tab === 'ask' ? '1' : '0', onClick: () => { setTab('ask'); setAttach(null) } }, '点歌'),
          h('button', { type: 'button', className: 'mp-tab', 'data-on': tab === 'skin' ? '1' : '0', onClick: () => { setTab('skin'); setAttach(null) } }, '外观'),
          h('button', { type: 'button', className: 'mp-tab', 'data-on': tab === 'keys' ? '1' : '0', onClick: () => { setTab('keys'); setAttach(null) } }, '按键'),
        ),
        message ? h('div', { className: 'mp-msg', 'data-kind': message.kind }, message.text) : null,
        state.error ? h('div', { className: 'mp-msg', 'data-kind': 'error' }, '连接失败：' + state.error) : null,
        h('div', { className: 'mp-body' },
          attach ? renderAttach()
            : tab === 'list' ? renderList()
              : tab === 'search' ? renderSearch()
                : tab === 'ask' ? renderAsk()
                  : tab === 'skin' ? renderSkin()
                    : renderKeys()),
        h('div', {
          className: 'mp-grip', title: '拖动可改大小',
          onPointerDown: (event) => { event.stopPropagation(); startPanelDrag(event, 'resize') },
        }),
      )
    }

    // ── apply ─────────────────────────────────────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx

        // 同一页面会话里出现第二个实例 = 插件被热替换，上一代的定时器/播放器可能还活着。
        // 与其猜哪一代残留，不如刷一次页面，从干净状态重新装配。普通加载不会触发。
        try {
          if (window.__dshMusicPlayerEpoch) {
            window.setTimeout(() => window.location.reload(), 1200)
            return
          }
          window.__dshMusicPlayerEpoch = Date.now()
        } catch { /* 忽略 */ }

        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-music-player')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-music-player: 样式')

        setupMediaSession()

        ctx.effect(() => {
          let lastTitle = null
          let lastPlaying = null
          const unsubscribe = subscribePlayer(() => {
            if (!('mediaSession' in navigator)) return
            const track = player.trackId ? trackById(player.trackId) : null
            const title = track ? track.title : ''
            if (title !== lastTitle) {
              lastTitle = title
              try {
                navigator.mediaSession.metadata = new MediaMetadata({
                  title: title || 'DSH 音乐播放器',
                  artist: track ? (track.artist || '') : '',
                  album: 'DSH 曲库',
                })
              } catch { /* 不支持就跳过 */ }
            }
            if (player.playing !== lastPlaying) {
              lastPlaying = player.playing
              try { navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused' } catch { /* ignore */ }
            }
          })
          return () => unsubscribe()
        }, 'dsh-music-player: 系统媒体键')

        try {
          const raw = window.localStorage.getItem('dsh-music-volume')
          if (raw != null && raw !== '') {
            const cached = Number(raw)
            if (Number.isFinite(cached) && cached > 0 && cached <= 1) {
              for (const el of [audioEl, videoEl]) if (el) el.volume = cached
              setPlayer({ volume: cached })
            }
          }
        } catch { /* 无痕模式忽略 */ }

        ctx.effect(() => {
          let saved = -1
          const unsubscribe = subscribePlayer(() => {
            // position 每 250ms 变一次，别跟着它同步写 localStorage。
            if (Math.abs(player.volume - saved) < 0.001) return
            saved = player.volume
            try { window.localStorage.setItem('dsh-music-volume', String(player.volume)) } catch { /* ignore */ }
          })
          return () => unsubscribe()
        }, 'dsh-music-player: 音量缓存')

        ctx.effect(() => {
          const onVisibility = () => {
            const visible = document.visibilityState === 'visible'
            setUi({ visible })
            if (visible) void syncState()
          }
          document.addEventListener('visibilitychange', onVisibility)
          window.addEventListener('keydown', handleKey, true)
          startPolling()
          void syncState()
          return () => {
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('keydown', handleKey, true)
            stopPolling()
          }
        }, 'dsh-music-player: 轮询与快捷键')

        ctx.effect(() => () => {
          stopProgressReporting()
          for (const el of [audioEl, videoEl]) {
            if (!el) continue
            try { el.pause() } catch { /* ignore */ }
            el.removeAttribute('src')
            if (el.parentNode) el.parentNode.removeChild(el)
          }
          audioEl = null
          videoEl = null
          if (parkedHost && parkedHost.isConnected) parkedHost.remove()
          parkedHost = null
          revokeAllBlobs()
          loadedTrackId = ''
        }, 'dsh-music-player: 媒体回收')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        const MiniEntry = () => h(Boundary, { fallback: 'mini' }, h(MiniPlayer))
        const PanelEntry = () => h(Boundary, { fallback: 'panel' }, h(Panel))
        const VideoEntry = () => h(Boundary, { fallback: 'panel' }, h(VideoWindow))

        try {
          slots.inject('conversation.header.leading', () => slots.register(
            { name: 'conversation.header.leading' },
            MiniEntry,
          ))
        } catch (error) {
          console.error('[dsh-music-player] 顶栏入口注册失败', error)
        }
        try {
          slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: 'dsh-music-player-panel', order: 60 },
            PanelEntry,
          ))
        } catch (error) {
          console.error('[dsh-music-player] 面板注册失败', error)
        }
        try {
          slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: 'dsh-music-player-video', order: 61 },
            VideoEntry,
          ))
        } catch (error) {
          console.error('[dsh-music-player] 视频窗注册失败', error)
        }
      },
    }
  },
})
