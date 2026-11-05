# qqbot-bridge

把 QQ 接到 [DSH](https://github.com/deepseek-ai/deepseek-harness) headless 会话上的桥接。

一个人设、一个 QQ 号、认真聊天：消息进来 → 找到它对应的 DSH 会话 → 跑一轮 → 把回复发回去。
附带记忆代写、主动开口与一组安全护栏。

```
QQ 用户
  ↕  腾讯服务器
NapCat（OneBot 11：HTTP 3000 / WS 3001）
  ↕
本桥接（Node，无第三方依赖）
  ↕  每条消息 spawn 一次 dsh
DSH headless（profile `bot`）→ 人设 / 心情 / 记忆
```

## 特性

| 能力 | 说明 |
|---|---|
| **一 peer 一会话** | 私聊、每个群各一条 DSH session，上下文不串 |
| **群聊说话人标签** | 群里每句注入 `[昵称]`，多人混聊时不会张冠李戴 |
| **群白名单 + 自动登记** | 静态名单之外的群，第一次被 @ 自动入册并持久化 |
| **记忆代写** | 模型只输出 `%%记住%% 内容`，由桥接写入收件箱（候选，需人工确认） |
| **主动开口** | 读心情引擎的 `urges`，攒到冲动时自己发一条；带静默时段、每日上限、最小间隔 |
| **限流** | 每 peer 每分钟上限、每群每日上限 |
| **可重启** | 断线重连（error/close 双触发）、90s 心跳沉默重建、5 分钟连不上主动退出交给 systemd |

## 前置

1. **NapCat**（QQ 协议端），开启 OneBot 11 的 HTTP 与正向 WebSocket，token 自定
2. **DSH CLI** + 一个 headless profile（示例里叫 `bot`），并装好人设与心情插件
3. 该 profile 的 `DSH_HOME` 独立（不要和你的工作台共用，否则人设/记忆会串）

## 使用

```bash
cp config.example.json config.json   # 按实际改 napcat.token、DSH_HOME、白名单
node src/index.js
```

`config.json` 与 `data/` 不入库（见 `.gitignore`）。

## 配置

| 字段 | 说明 |
|---|---|
| `napcat.ws/http/token` | OneBot 连接参数 |
| `dsh.profile` | 用哪个 DSH profile |
| `dsh.cwd` / `dsh.env.DSH_HOME` | 子进程工作目录与 home；**cwd 必须固定**，DSH 会比对会话记录的 cwd |
| `memory.inboxPath` | 记忆收件箱路径（`whale-persona` 的 `memory-inbox.jsonl`） |
| `memory.moodStatePath` | 心情状态（`fish-mood` 的 `state.json`），主动开口的触发源 |
| `proactive.*` | 开关、检查频率、最小间隔、每日上限、静默时段 |
| `policy.allowUsers` | 私聊白名单；**空数组 = 谁都不理** |
| `policy.allowGroups` | 群白名单；未列出的群首次被 @ 时自动登记（`autoJoinGroups`） |
| `policy.groupRequireAt` | 群里必须 @ 才回 |

## 部署（systemd）

```bash
install -m 644 deploy/qqbot-bridge.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qqbot-bridge
journalctl -u qqbot-bridge -f
```

## 部署脚本

改完代码，一条命令上线（提交、推送、服务器拉取、重启、看日志）：

```bash
./deploy.sh "这次改了什么"
```

服务器地址默认 `root@120.53.2.49:80`、目录 `/opt/qq-bot`，可用环境变量 `QQBOT_HOST` / `QQBOT_PORT` / `QQBOT_DIR` 覆盖。
服务器端只需配置一把只读 deploy key，`config.json` 与 `data/` 已在 `.gitignore` 中，不会被覆盖。

## 设计取舍

- **每条消息起一个 dsh 进程**（约 3–6 秒）：换来零常驻状态、崩了不影响下一轮。量大再改常驻。
- **记忆由桥接代写**：模型没有文件权限，只输出 `%%记住%%` 标记；写入的是候选，人工 `confirm` 才生效。
- **工具面收窄**：bot profile 里禁掉文件/shell/子 agent，否则群里任何人都能诱导它读写文件。
- **不暴露端口**：NapCat 的 WebUI 与 OneBot 只绑 `127.0.0.1`，远程用 SSH 隧道。

## 踩过的坑（真机）

1. **重连只挂在 `onclose` 会永久失联**：连接失败时可能只发 `error` 不发 `close`，重试链断在第一次，进程还活着但永远不会再连。现在两者都触发，并配看门狗。
2. **DSH 的 profile 作用域**：`dsh plugin add` 不带 `DSH_HOME` 会装到默认 home，和你实际运行的 profile 不是同一个 —— 表现是「插件装了但人设不生效」。
3. **QQ 会话掉线是静默的**：账号被风控下线后，OneBot 服务跟着停，但容器与 WebUI 还在，看起来「一切正常」。

## 限制

- 依赖 **NapCat 这类协议端**，属于腾讯明确打击的「外挂」范畴，账号随时可能被限制或封禁
- 没有图片/语音能力，消息里的图片只保留 `[图片]` 占位
- 主动开口只有一个触发源（心情引擎的冲动），没有按日程/事件触发的机制

## License

MIT
