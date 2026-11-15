# dsh-music-player

DSH 桌面端的音乐 + 视频播放器插件：顶栏常驻迷你条、悬浮面板、可拖拽视频窗。能放本地曲库（音频和视频混在一起管），也能把「想听什么 / 帮我整理」交给模型，用唧唧DOWN 自带的 ffmpeg 在后台生成 mp3 或合并 mp4。

- 入口：`conversation.header.leading`（顶栏标题左侧的胶囊）
- 面板：`shell.overlay`（`dsh-music-player-panel`）
- 视频窗：`shell.overlay`（`dsh-music-player-video`）
- 依赖：`webServer`、`tools`、`agents`

## 安装

需要 DSH 桌面端（自带 Node 与 Electron）；B 站下载另需本机有 **ffmpeg**——推荐直接复用唧唧DOWN 自带的那个（`D:\Program Files\JiJiDown\OrderEXE\ffmpeg.exe`），没有就装一个并把 `ffmpegPath` 指过去。

```bash
# 1) 拿到仓库
git clone https://github.com/<owner>/dsh-music-player.git
cd dsh-music-player

# 2) 装进当前 DSH profile（也可以直接在「插件 → 添加插件」里选这个目录）
plugin_manager install_bundle target=<本目录绝对路径>
```

装好后在插件列表里确认 `dsh-music-player` 已启用，刷新页面就能看到顶栏胶囊。

**点歌需要配套预设**（可选，不装就只少点歌这一块）：

```bash
plugin_manager install_bundle target=<仓库>/preset
```

它声明预设 `music`，点歌时用一次性子代理干活，不把聊天历史喂给模型。详见 [preset/README.md](preset/README.md)。

## 能干什么

- **放**：音频交给 `<audio>`，视频交给 `<video>`；媒体由宿主路由 `/dsh-music/media/<id>` 以 Range 方式提供，拖进度条不用整首/整段下完。
- **看得懂状态**：顶栏胶囊最左侧是 ▶/⏸ 切换的状态标记（播放中双杠会呼吸，切换有缩放动画）；视频用**胶卷图标**标记，和音频的 `♪` 分开。
- **拖得动**：进度条按真实时长细分拖动；媒体源走本地 blob（≤80MB），`seekable` 等于全长，拖到哪儿放哪儿；短片子时间显示带小数。
- **自己挪**：面板按住标题区拖动、拖右下角改大小，位置尺寸记在 localStorage，「外观 → 面板 → 复位」还原；视频窗同样可拖可缩。
- **整理**：排序、类型筛选（音频/视频）、关键词过滤、歌单（多归属）。行内 `＋` 会把面板切成**歌单目录**（全部歌单 + 勾选状态，点一行即加入/移出，可直接新建并顺带加入）；批量勾选后同样走这个目录。
- **找**：B 站搜索直连宿主代理，可选下音频或下视频，选中歌单时下完自动进单。
- **问**：点歌面板每次单开一个一次性子代理（预设 `music`、只有 `music_*` 六个工具、思考档位 low），不带聊天历史，按「找新歌 / 整理曲库 / 播给我听」三种模式自己动手，跑完直接把回话显示在面板里；「深度思考」要求先推理再执行。
- **窗口**：视频窗自带进度条、上一首/播放/下一首、音量、PiP；可拖动、缩放，位置尺寸记忆；**全屏是真全屏**（浏览器 Fullscreen API，DSH 的标题栏/侧栏/右上角按钮都让位），全屏下鼠标静默 2.6 秒自动隐藏控件，动一下就回来。音频时给提示。
- **按键**：全局与面板内两组快捷键都能自己绑，点一下再按键即可。
- **外观**：六套预设 + 主色/底色/模糊/透明度/圆角/氛围光/动画；可**导入自己的背景图**、填自定 CSS 渐变，或**让模型按一句描述设计**（模型调 `music_skin` 落盘）。
- **存储**：默认 `E:\DshMusic`，可在面板里一键/自定目录迁移（复制+删除，同步索引）。
- **省**：页面隐藏不发请求；面板收起后轮询降到 6 秒；动画只在可见时跑；状态没变时不重渲染面板。
- **稳**：写接口要求自定义头（防跨站改设置）；媒体流补了错误监听（文件被删/盘掉线不会带走宿主）；Range 非法值回 416；下载有超时与队列上限保护；曲目行支持键盘操作、`:focus-visible` 有焦点环；系统媒体键（耳机线控）可用。

## 工具（给模型）

`music_search` · `music_download`（audio/video）· `music_playlist` · `music_library`（含 migrate）· `music_player`（含 video_window / open / close）· `music_skin`

## 和唧唧DOWN 的关系

下载链路复用的是唧唧DOWN 的两个资产：

1. `D:\Program Files\JiJiDown\OrderEXE\ffmpeg.exe` —— 它自带的定制 ffmpeg（`libmp3lame`、`mp3`/`mp4` muxer、`mov`/`flv` demuxer），负责 mp3 转码和 mp4 合流；
2. `D:\Program Files\JiJiDown\Download` —— 默认一起扫进曲库，手动用唧唧下的文件也会出现在播放列表里。

唧唧DOWN 的 WPF 客户端本身没有可用的命令行下载模式（带任何参数启动都会立刻退出），所以没有去驱动它的界面，也不会弹窗。

## 配置

`%USERPROFILE%\.dsh\music-player\settings.json`，面板里能改大部分：

| 键 | 说明 |
| --- | --- |
| `downloadDir` / `jijidownDir` / `ffmpegPath` | 下载目录、唧唧目录、转码器 |
| `scanJijidown` | 是否把唧唧目录一起入库 |
| `maxConcurrent` | 同时下载几个（1~3） |
| `autoVideoWindow` | 播视频是否自动开视频窗 |
| `askMode` / `askThink` | 点歌模式与深度思考开关 |
| `askFresh` / `askPreset` / `askProvider` / `askModel` / `askEffort` / `askTimeoutMs` | 点歌代理：是否用一次性子代理、预设 id、模型路由、思考档位、等待上限 |
| `shortcuts.global` / `shortcuts.panel` | 两组快捷键绑定（`event.code` 拼法） |
| `volume` / `sort` / `asc` / `kind` / `skin` | 播放与界面状态 |

## 目录

```
index.js            插件入口：路由、工具、初始化
client.js           网页半端：迷你条 + 面板 + 视频窗 + 快捷键
lib/bili.js         B 站接口（搜索/视频信息/音频与视频直链/流下载，含 cookie 与 412 重试）
lib/store.js        曲库/歌单/设置持久化、目录扫描、文件名解析、默认快捷键
lib/downloader.js   下载队列（并发、进度、mp3 转码与 mp4 合流）
preset/             配套预设包（曲库助手，可选安装）
docs/DETAIL.md      插件详情页
locale/*.json       插件管理器的标题与描述
icon.svg            图标
```

## 数据

| 文件 | 内容 |
| --- | --- |
| `library.json` | `{ version: 2, tracks[], playlists[] }` |
| `settings.json` | 见上表（含 `skin.bgFile` 指向导入的背景图） |
| `skin/` | 导入的背景图（浏览器先缩到 1600px 再存） |

以上都在 `%USERPROFILE%\.dsh\music-player\`，不进仓库、不上传。

## 已知边界

- 唧唧DOWN 的 WPF 客户端没有命令行下载模式，插件只复用它的 ffmpeg 与 Download 目录，不驱动它的界面。
- 番剧、直播没有 DASH 流；视频清晰度受账号权限限制（未登录一般最高 480P/720P）。
- 迁移同名文件会跳过并报数量；跨盘走复制+删除，中途失败的文件会留在原处。
- 超过 `blobMaxMB`（默认 256 MB）的媒体走 HTTP 流式，个别情况下拖动可能不准，面板会提示。
- 「点歌」是模型能力，需要一个能跑的 provider 路由（默认 `deepseek-official / deepseek-flash`），可在 `settings.json` 改。

## 隐私与网络

- 没有遥测、没有账号体系，插件只写本地文件。
- 出站请求只有两类：B 站接口（搜索/视频信息/播放直链/下载）与 DeepSeek 模型（点歌）。封面走宿主代理，只允许 B 站图床。
- 写接口要求同源或自定义头 `x-dsh-music-client: 1`，跨站网页改不了你的设置。

## License

[MIT](LICENSE)
