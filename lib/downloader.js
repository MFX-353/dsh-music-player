/**
 * 下载队列（Host 侧）。
 *
 * 音频：BV → cid → DASH 音频流 → tmp → 唧唧DOWN 自带 ffmpeg 转 mp3
 * 视频：BV → cid → DASH 视频流(优先 avc1) + 音频流 → 两段下载 → ffmpeg -c copy 合并成 mp4
 * 两种都全程后台，不弹唧唧的窗口；并发默认 2，进度同时回报给面板。
 */
import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { audioStreams, downloadStream, videoInfo, videoStreams } from './bili.js'
import { safeName } from './store.js'

function runFfmpeg(ffmpegPath, args, output, label) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !existsSync(ffmpegPath)) {
      reject(new Error('找不到 ffmpeg（唧唧DOWN 的 OrderEXE 缺失）'))
      return
    }
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    // ffmpeg 卡在坏文件/坏流上不会自己退，加个兜底：10 分钟还没完就杀掉。
    const killer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出 */ }
    }, 10 * 60 * 1000)
    if (typeof killer.unref === 'function') killer.unref()
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 20000) stderr = stderr.slice(-10000)
    })
    child.on('error', (error) => {
      clearTimeout(killer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0 && existsSync(output)) resolve(true)
      else {
        const tail = stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)
        reject(new Error((label || 'ffmpeg') + ' 失败（exit ' + code + '）：' + tail))
      }
    })
  })
}

export class Downloader {
  constructor(store, onChanged) {
    this.store = store
    this.onChanged = onChanged || (() => {})
    this.jobs = []
    this.running = 0
    this.stopped = false
    this.serial = 0
  }

  list() {
    return this.jobs.map(job => ({
      id: job.id,
      bvid: job.bvid,
      kind: job.kind,
      title: job.title,
      status: job.status,
      progress: Math.round(job.progress * 100) / 100,
      error: job.error,
      trackId: job.trackId,
      at: job.at,
      tags: job.tags,
      category: job.category,
      phase: job.phase,
    }))
  }

  active() {
    return this.jobs.some(job => job.status === 'queued' || job.status === 'running')
  }

  /**
   * 排队一批下载。
   * @param {Array<{bvid: string, kind?: 'audio'|'video', title?: string, artist?: string, tags?: string[], category?: string}>} items
   */
  enqueue(items) {
    const accepted = []
    for (const item of items) {
      const bvid = String((item && item.bvid) || '').trim()
      if (!/^BV[0-9A-Za-z]+$/.test(bvid)) continue
      const kind = item.kind === 'video' ? 'video' : 'audio'
      const existing = this.jobs.find(job => job.bvid === bvid && job.kind === kind
        && (job.status === 'queued' || job.status === 'running'))
      if (existing) { accepted.push(existing); continue }
      const job = {
        id: 'j' + (++this.serial) + '-' + randomUUID().slice(0, 6),
        bvid,
        kind,
        title: String(item.title || ''),
        artist: String(item.artist || ''),
        tags: Array.isArray(item.tags) ? item.tags.filter(Boolean).map(String).slice(0, 8) : [],
        category: String(item.category || ''),
        status: 'queued',
        progress: 0,
        phase: '排队中',
        error: '',
        trackId: '',
        playlistId: String(item.playlistId || ''),
        at: Date.now(),
      }
      this.jobs.push(job)
      accepted.push(job)
    }
    // 只淘汰已经结束的任务。旧写法直接 slice(-80)，会把还在排队的 job 静默挤掉——
    // 它们再也不会被 pump 捡到，调用方还收到 ok:true。
    const ended = (job) => job.status !== 'queued' && job.status !== 'running'
    while (this.jobs.length > 80) {
      const index = this.jobs.findIndex(ended)
      if (index < 0) break
      this.jobs.splice(index, 1)
    }
    let live = 0
    for (const job of this.jobs) {
      if (!job.status || ended(job)) continue
      live += 1
      if (live > 80) {
        job.status = 'cancelled'
        job.phase = '已取消（队列已满）'
        job.error = '排队超过 80 个，这条没排上，请稍后重试'
      }
    }
    this.onChanged()
    void this.pump()
    return accepted
  }

  async pump() {
    if (this.stopped) return
    const max = Math.max(1, Math.min(3, Number(this.store.settings.maxConcurrent) || 2))
    while (this.running < max) {
      const job = this.jobs.find(candidate => candidate.status === 'queued')
      if (!job) break
      this.running += 1
      job.status = 'running'
      job.progress = 0.02
      job.phase = job.kind === 'video' ? '取视频信息' : '取音频信息'
      this.onChanged()
      void this.run(job).finally(() => {
        this.running -= 1
        this.onChanged()
        void this.pump()
      })
    }
  }

  /** 下完直接进指定歌单（面板下载时带上的归属）。 */
  async attachPlaylist(job, trackId) {
    if (!job.playlistId || !trackId) return
    const result = this.store.bulkPlaylist(job.playlistId, [trackId], 'add')
    if (result) await this.store.save()
  }

  async run(job) {
    const settings = this.store.settings
    const workDir = this.store.tmpDir
    const srcFile = path.join(workDir, job.id + (job.kind === 'video' ? '.vsrc' : '.asrc'))
    const audioFile = path.join(workDir, job.id + '.asrc')
    try {
      const known = this.store.list().find(track => track.bv && track.bv === job.bvid && track.kind === job.kind)
      if (known) {
        job.status = 'skip'
        job.trackId = known.id
        job.progress = 1
        job.phase = '曲库已有'
        job.title = job.title || known.title
        await this.attachPlaylist(job, known.id)
        return
      }
      const info = await videoInfo(job.bvid)
      job.title = job.title || info.title
      job.artist = job.artist || info.author
      if (!job.category) job.category = '未分类'
      job.progress = 0.08
      this.onChanged()

      const dir = settings.downloadDir
      await fsp.mkdir(dir, { recursive: true }).catch(() => {})
      const base = safeName([job.title, job.artist].filter(Boolean).join(' - ') || info.title, job.bvid)

      if (job.kind === 'video') {
        job.phase = '取视频流'
        const videos = await videoStreams(info)
        const video = videos[0]
        job.phase = '下载视频'
        await downloadStream(video, srcFile, {
          onProgress: (ratio) => {
            job.progress = 0.1 + Math.min(1, ratio) * 0.5
            this.onChanged()
          },
        })
        job.phase = '下载音轨'
        const audios = await audioStreams(info)
        const audio = audios[0]
        await downloadStream(audio, audioFile, {
          onProgress: (ratio) => {
            job.progress = 0.6 + Math.min(1, ratio) * 0.15
            this.onChanged()
          },
        })
        job.phase = '合并 mp4'
        job.progress = 0.8
        this.onChanged()
        const finalFile = path.join(dir, base + ' (' + job.bvid + ').mp4')
        await runFfmpeg(settings.ffmpegPath, [
          '-y',
          '-i', srcFile,
          '-i', audioFile,
          '-c', 'copy',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-movflags', '+faststart',
          finalFile,
        ], finalFile, '视频合并')
        const stat = await fsp.stat(finalFile)
        const track = this.store.addTrack({
          file: finalFile,
          kind: 'video',
          title: info.title || job.title,
          artist: info.author || job.artist,
          duration: info.duration,
          cover: info.cover,
          bv: job.bvid,
          tags: job.tags,
          category: job.category,
          source: 'download',
          size: stat.size,
          width: video.width,
          height: video.height,
          addedAt: Date.now(),
        })
        job.trackId = track.id
        await this.attachPlaylist(job, track.id)
        job.progress = 1
        job.status = 'done'
        job.phase = '完成 ' + Math.round(stat.size / 1024 / 1024) + 'MB'
        return
      }

      job.phase = '取音频流'
      const streams = await audioStreams(info)
      const stream = streams[0]
      job.phase = '下载音频'
      await downloadStream(stream, srcFile, {
        onProgress: (ratio) => {
          job.progress = 0.1 + Math.min(1, ratio) * 0.75
          this.onChanged()
        },
      })
      job.phase = '转 mp3'
      job.progress = 0.87
      this.onChanged()
      let finalFile = path.join(dir, base + ' (' + job.bvid + ').mp3')
      let usedFallback = false
      try {
        await runFfmpeg(settings.ffmpegPath, [
          '-y', '-i', srcFile, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-f', 'mp3', finalFile,
        ], finalFile, 'mp3 转码')
      } catch (error) {
        usedFallback = true
        finalFile = path.join(dir, base + ' (' + job.bvid + ').m4a')
        await fsp.copyFile(srcFile, finalFile)
        job.error = String(error && error.message ? error.message : error) + '；已改存为 m4a'
      }
      const stat = await fsp.stat(finalFile)
      const track = this.store.addTrack({
        file: finalFile,
        kind: 'audio',
        title: info.title || job.title,
        artist: info.author || job.artist,
        duration: info.duration,
        cover: info.cover,
        bv: job.bvid,
        tags: job.tags,
        category: job.category,
        source: 'download',
        size: stat.size,
        addedAt: Date.now(),
      })
      job.trackId = track.id
      await this.attachPlaylist(job, track.id)
      job.progress = 1
      job.status = 'done'
      job.phase = usedFallback ? '完成（m4a）' : '完成 mp3'
    } catch (error) {
      job.status = 'error'
      job.phase = '失败'
      job.error = String(error && error.message ? error.message : error).slice(0, 300)
    } finally {
      await fsp.unlink(srcFile).catch(() => {})
      if (job.kind === 'video') await fsp.unlink(audioFile).catch(() => {})
      this.onChanged()
    }
  }

  stop() {
    this.stopped = true
    for (const job of this.jobs) {
      if (job.status === 'queued') job.status = 'cancelled'
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter(job => job.status === 'queued' || job.status === 'running')
    this.onChanged()
  }
}
