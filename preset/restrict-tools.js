/**
 * 曲库助手预设的收窄插件：把全局工具削到只剩 music_* 六个。
 *
 * 为什么要有它：music_* 是 music-player 插件在宿主层注册的全局工具，预设本身
 * 挂不了「只保留某几个」的配置；而宿主层还挂着 MCP、QQ 桥、商店之类的一堆
 * 工具，子代理全会看见——工具越多，提示词越贵、选错工具的几率越大。
 * 预设是 Agent 作用域，在这里调 ctx.tools.restrict 只影响用这个预设的会话。
 *
 * 注册顺序不可靠（预设是启动即激活的，music-player 可能还没装完），所以失败
 * 就等下一次 tools/change 再试；只试有限次数，成功一次就收手，避免自己触发
 * tools/change 再自我重入。
 */

export const name = 'restrict-music-tools'
export const inject = ['tools']

const ALLOW = ['music_search', 'music_download', 'music_playlist', 'music_library', 'music_player', 'music_skin']

export function apply(ctx) {
  let lift = null
  let tries = 0
  const tryApply = () => {
    if (lift !== null || tries >= 20) return
    tries += 1
    try {
      lift = ctx.tools.restrict({ allow: ALLOW })
    } catch {
      lift = null
    }
  }
  ctx.effect(() => {
    tryApply()
    const off = ctx.on('tools/change', () => { tryApply() })
    return () => {
      try { off() } catch { /* 已经注销 */ }
      try { if (lift !== null) lift() } catch { /* 已经解除 */ }
      lift = null
    }
  }, 'restrict-music-tools')
}
