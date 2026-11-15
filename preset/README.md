# 曲库助手预设（dsh-music-agent-preset）

给 [dsh-music-player](../README.md) 的「点歌」用的一次性代理预设，独立成包是因为 DSH 的预设必须由 bundle 声明。

## 装

```
plugin_manager install_bundle target=<本目录绝对路径>
```

装完 `dsh-music-player` 点歌时就会用 `agentPreset: 'music'` 起一个干净的子代理：系统提示词只有几百字曲库规则、工具只留 `music_*`、思考档位默认 `low`、不带聊天历史。

## 不装会怎样

点歌按钮会报「引擎没挂/预设不存在」——老行为（把话递回当前会话）需要把 `settings.json` 里的 `askFresh` 设成 `false`，不推荐：那会把整段聊天历史都喂给模型。

## 里面是什么

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 声明预设 `music`：`@deepseek-ai/dsh-persona`（complete 模式）+ 本包的 `restrict-tools.js` |
| `restrict-tools.js` | 在预设作用域里 `ctx.tools.restrict({ allow: [...music_*] })`，把宿主其余工具收窄掉 |

## License

MIT
