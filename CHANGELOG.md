# 更新日志

## 2.6.1

- 修复 `music_library list` / `music_download` / `music_playlist detail` 返回两首以上时抛 `playlistMap.get is not a function`（2.5.0 给 `publicTrack` 加第二参数后，`Array.map(publicTrack)` 把数组下标当成歌单映射传了进去；下标 0 会走兜底所以只崩「多首」）。
## 2.6.0

- **媒体源**：整段读成 blob 的阈值改成 `settings.blobMaxMB`（默认 256），Chromium 的大 blob 会落盘，绝大多数 1080p 视频拖动可用；超过阈值才退回 HTTP 流式，并且面板会显示「流式 · 可能拖不准」。
- **播放位置**独立 store：`timeupdate`（约 4Hz）不再写进 `player`，只让进度条与时间文本重渲染；`player.position` 每 2 秒同步一次供上报/恢复。
- **死代码清理**：`fmtSize`、`lastCommand`、`.mp-pop*`、`.mp-video[data-full]`、`MusicStore.reorder()`、`bili.formatDuration()`、两处未用 `statSync` 导入。

## 2.5.0

自检与加固（安全 / 数据 / 性能 / 交互四类）：

- 写接口要求自定义头或同源，堵掉「任意网页改设置 → 读任意文件 / 跑任意程序」。
- 三处 `createReadStream().pipe()` 补 `error` 监听；Range 非法区间回 416；`readBody` 改 Buffer 收齐、超限 413、坏 JSON 400。
- `/api/playback` 白名单收敛；遥控命令 30 秒过期 + ack 后 bump rev + 客户端按 id 去重。
- `addTrack` 保留用户维护的标签/分类/收藏/封面；`removeTrack` 先删文件后删索引（占用时抛 `file_locked`）；迁移目录加目录边界并分批落盘。
- 下载队列上限只淘汰已结束任务；启动清理 `.asrc/.vsrc` 残留；ffmpeg 10 分钟兜底 kill；B 站接口与下载流加超时。
- `has()` 改路径索引（扫描 O(N²) → O(N)）；`buildState` 一次建曲目→歌单映射；客户端同 rev 跳过快照、并发同步复用请求、排序用共享 `Intl.Collator`、滑杆防抖、音量写盘节流。
- 交互：批量删文件二次确认、曲库行键盘可操作、焦点环与触屏操作按钮常显、窗口缩放自动夹回、静音记住原音量、提示条后到顶前到、渲染兜底可重试、新增「最近播放」排序、点歌超时自动补答案、接 `navigator.mediaSession`。

## 2.4.0

- 「点歌」改成一次性子代理：`ctx.subagents.startActivation` + 专用预设 `music`，不读聊天历史；思考档位默认 `low`；结果直接显示在面板里。
- 配套 bundle：`dsh-music-agent-preset`（`preset/` 目录）。
- `/api/ask` 支持 `askFresh` 开关回退旧行为；新增 `/api/ask/status` 与 `/api/debug/agents`。

## 2.3.1

- 修「拖进度条会重播」：媒体源走本地 blob，`seekable` 等于全长；媒体元素不脱离文档。超过 80 MB 退回流式。
- 短媒体时间显示带一位小数，进度条 step 按时长自适应。

## 更早

- 项目起于「唧唧DOWN 曲库 + B 站下载」：DASH 流 + 唧唧自带 ffmpeg 转 mp3 / 合 mp4；本地曲库、歌单、批量整理、搜索、视频窗、皮肤与按键。
