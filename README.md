# dsh-qgent

把 QQ 变成 **agent 的通道**，而不是一个只会"你一句我一句"的应声虫。

`qgent` = agent 的 a 换成 q。它替换掉 `dsh-qqbot` 那套「收到消息 → 排队跑完 → 把模型这次说的所有话原样发回去」的流程，改成：

- **回复是工具**：不调用 `qq_send`，模型说什么都不会出现在 QQ 里；
- **干活途中能说话**：一个回合里可以多次 `qq_send`，先发"在查了"，再发结果；
- **新消息有两种投递方式**：`steer` 在当前回合的下一步插进来（边干边聊），`queue` 等这轮干完再处理（排队做任务）；
- **文件/图片**走 `qq_send_file`，不再是自动把所有东西都发出去。

## 和 dsh-qqbot 的区别

| | dsh-qqbot | qgent |
| --- | --- | --- |
| 回复怎么发 | 自动转发每条 assistant 消息 | 只有 `qq_send` / `qq_send_file` 会发 |
| 工作途中说话 | 不行，要么等 turn 结束，要么流式整段 | 随时调工具，发一句继续干 |
| 新消息 | 并发队列，跑完当前再跑下一条 | `steer`（插话，下一步就读到）或 `queue`（排队） |
| 发文件 | 轮末自动投递 `present` 的文件 | 模型显式调用 `qq_send_file` |
| 会话 | 每个 QQ 聊天一个 session | 一样，映射规则是确定的，重启后接上 |

## 工具

| 工具 | 做什么 |
| --- | --- |
| `qq_send` | 发一条文字到当前会话绑定的 QQ 聊天。超长自动分段。可选 `chat` 参数发到别的已知聊天 |
| `qq_send_file` | 发本地文件 / 图片 / 视频 / 语音。`path` 相对会话工作目录解析，默认限制在工作目录和媒体目录内 |
| `qq_chats` | 列出这台 Host 见过的 QQ 聊天（`c2c:<openid>` / `group:<openid>`）、标签、最后活跃时间，以及 QQ 连接状态 |

工具在**任何会话**里都可见：QQ 会话不传 `chat` 就发给绑定的聊天；从 DSH 网页里的会话也能用 `chat` 主动往 QQ 发（只能发给已经和 bot 说过话的聊天，避免被群里的提示注入当外发通道）。

## 两种投递模式

收到 QQ 消息时，插件按配置的 `mode` 把它送进 session：

- `steer`（默认）：如果 agent 正在干活，这条消息在**下一步**就进来，模型可以边干边回；空闲时则直接开一轮。
- `queue`：插到下一轮，当前这轮干完再处理，适合连续丢好几个任务。

也可以在 QQ 消息前面加前缀临时改：`#steer 先别改那个文件`、`#queue 顺便跑一下测试`。

## 聊天里的命令

在 QQ 里直接发（不用 @ 也行，按群设置）；命令在进模型之前就被拦下，不消耗回合：

| 命令 | 作用 |
| --- | --- |
| `/new`（别名 `/reset` `/clear`） | 给这个聊天开新会话：换一代 session id，旧上下文不再参与。**旧记录不会被删**——它还是磁盘上的一个普通 session，能在 DSH 的会话列表里翻到 |
| `/stop` | 打断当前正在跑的回合（相当于 Ctrl+C），不动会话绑定 |
| `/status` | 连接状态、当前会话、模型、preset、消息数 |
| `/model [provider/model]` | 不带参数列可用模型；带参数换模型（fork 当前会话，上下文保留） |
| `/preset [id]` | 列 preset / 选 preset，**下一条 `/new` 生效**（已开始的会话不换） |
| `/compact` | 原地压缩当前会话历史，返回压缩条数/tokens |
| `/approve [编号]` / `/deny [编号]` | 批准 / 拒绝一个待审批操作（见下） |
| `/ping` `/version` | pong / 版本号 |
| `/help`（`/bot-help`） | 命令表 |

`/new 顺便看下 xxx` 这种带内容的写法，会在开新会话后把 `顺便看下 xxx` 作为新会话的第一条消息。

实现上，qgent 在 `~/.dsh/qgent/chats.json` 里给每个聊天记「代数」和几个覆盖项（fork 出来的 session id、模型、preset），session id 默认由 `qgent:<appId>:<scope>:<peerId>:<代数>` 哈希出来——代数一变，下一条消息就新建会话，而不是 resume 旧的。

投递走宿主自己的 `sessionController.prompt`，所以消息在会话记录里留痕、可回放，和网页端发消息是同一套机制。

## 一个回合长什么样

```
user(QQ): 帮我看看 D 盘那个项目的测试为什么挂了

assistant → qq_send("在看了，先跑一下")
assistant → bash(npm test) → ...
assistant → qq_send("是 utils 里少了个 return，我改一下再跑")
assistant → edit → bash(npm test) → ...
assistant → qq_send("修好了，测试全绿")
```

模型一轮说完却一次都没调用 `qq_send` 时，插件会把**最后一条**回答补发到 QQ（`fallbackReply: true`），避免对方一直干等；不想要这个兜底就设成 `false`，变成严格的"只发工具"。

## 会话映射

`qgent:<appId>:<scope>:<peerId>` 哈希成固定的 UUID 形式的 session id：

- 私聊：`peerId` = 对方 openid
- 群聊：`peerId` = 群 openid

同一个聊天重启后 `resume` 回原来的 session；找不到就按配置的 `cwd` / `preset` / `model` 新建。空闲超过 `sessionIdleTimeout` 的会话会被回收。

## 安装

```bash
# 从仓库装（DSH 会把它挂进当前 profile）
dsh plugin install https://github.com/fanrena/dsh-qgent

# 或本地目录
dsh plugin install /path/to/dsh-qgent
```

装完记得**停掉 dsh-qqbot**：同一个 AppID 同时连两条 WebSocket 会互相踢。

```bash
dsh plugin disable @tencent-connect/dsh-qqbot
```

qgent 自带设置页（`设置 → QQ 机器人`），所以停掉 dsh-qqbot 不会丢掉配置入口。第一次装、或者 qgent 升级后改了 `client.js` 时，**重启一次 DSH** 让客户端模块重新注册，之后改配置只用刷新页面。

QQ SDK 依赖 `@tencent-connect/qqbot-nodejs`。插件会依次从「宿主解析 → profile 的 node_modules → 插件目录的 node_modules」找它，所以已经装过 dsh-qqbot 的 profile 通常不用再装；否则在插件目录跑一次 `npm install` 即可。

## 设置页

`设置 → QQ 机器人`，一眼看到：

- **连接状态**：绿点=已连上 QQ，旁边是 AppID；没连上会显示原因。
- **行为**：群里是否只回 @、新消息投递方式（steer / queue）、没调用 `qq_send` 时是否补发最后一条、调试日志。
- **模型与 preset**：留空就用宿主默认。
- **工作目录（cwd）**：agent 干活的位置，留空用宿主默认。只影响**新建**会话；已经存在的会话保持原目录，换目录用 `/new`。会话建好后会挂到路径相同的工作区上——如果那个目录还不是 DSH 工作区，qgent 会自动注册一个（DSH 自己的 home/profile 目录除外）。
- **人设 / 额外提示词**：群聊、私聊各一份，会追加到通道说明后面。
- **服务范围**：私聊 / 群聊的开放、白名单、禁用。
- **凭据**：手填 AppID / AppSecret 会写进 qgent 自己的配置行；「解绑」清空凭据并让 qgent 保持离线。

保存会写 profile 的 `cordis.patch.yml` 里 `qgent` 这一行，Loader 随即热重载。**扫码绑定没有搬过来**：凭据来自配置、环境变量，或者 `inheritQQBot` 沿用 profile 里已绑定的 `im-qqbot` 行。

## 凭据

按优先级：

1. 配置里的 `appId` / `appSecret`；
2. 环境变量 `QQBOT_APPID` / `QQBOT_SECRET`；
3. `inheritQQBot: true`（默认）时，从当前 profile 的 `cordis.patch.yml` 里已绑定的 `im-qqbot` 行继承 —— 之前扫码绑定过的话，装上就能用。

同一个 AppID 只能有一个进程连 QQ；qgent 和 dsh-qqbot 不要同时启用。

## 配置

`cordis.patch.yml` 里 `qgent` 行的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | `''` | QQ 机器人凭据；留空则走环境变量 / im-qqbot 继承 |
| `inheritQQBot` | `true` | 从 profile 的 im-qqbot 行继承凭据 |
| `requireMention` | `false` | 群聊是否必须 @ 才进模型；`false` 时每条群消息都进，由模型自己决定回不回 |
| `mode` | `steer` | 新消息默认投递方式：`steer` / `queue` |
| `fallbackReply` | `true` | 一轮没调用 `qq_send` 时补发最后一条回答 |
| `markdown` | `true` | 用 markdown 发；失败自动退回纯文本 |
| `textChunkLimit` | `4500` | 单条消息最大字符数 |
| `sessionIdleTimeout` | `1800000` | 会话空闲回收（毫秒） |
| `historyLimit` | `10` | 群聊历史缓冲条数，作为上下文带给模型 |
| `cwd` | `''` | agent 工作目录；留空用 Host 进程 cwd |
| `preset` / `provider` / `model` | `''` | 可选，指定 agent preset / 模型 |
| `groupPrompt` / `directPrompt` | `''` | 追加到 qgent 通道说明后面的人设/额外提示词 |
| `access` | `open` | `c2cMode` / `groupMode` = `open` / `allowlist` / `disabled`，白名单在 `c2cAllow` / `groupAllow` |
| `media.enabled` / `media.maxMB` | `true` / `200` | 是否把对方发来的图片/文件下载到本地并把路径给模型 |
| `sendFile.restrictPaths` / `extraRoots` | `true` / `[]` | 限制 `qq_send_file` 只能发工作目录、媒体目录和额外根目录里的文件 |
| `debug` | `false` | 打印入站消息摘要 |

## 已知边界

- 只处理私聊（C2C）和群聊；频道/频道私信忽略。
- 一个 AppID 只能跑一个实例；多开没有做分片。
- 群聊里如果有**别的机器人**也在说话，QQ 又把这些消息投给本 bot，两个 bot 会互相接话、上下文越滚越重复，最后模型可能退化成复读或乱吐字符。qgent 没有做 bot 消息过滤或入站限流（`skipSelfEcho: false`），真出现对刷就把其中一个 bot 移出群，或者用 `/stop` 打断。
- `steer` 的"下一步"取决于 agent 当前这一步什么时候结束：模型正在生成长回答时，插话要等这次生成结束。
- 会话的 preset 在首次创建时确定；之后改 `preset` 只影响新会话。

### 审批（agent 请求权限）

当宿主需要用户批准某个操作（例如执行一条命令），qgent 会把请求发到对应的 QQ 聊天：

```
🔐 需要你批准一个操作
工具：bash

```
git push origin main
```

说明：……

回复 `/approve 1` 允许一次，或 `/deny 1` 拒绝。
```

- 批准只对**这一次**生效（宿主只提供 `allowed-once`，没有“总是允许”）。
- 编号是全局递增的；只回 `/approve` 不带编号也行，前提是当前聊天只有一个待审批。
- 5 分钟没回、或那轮被 `/stop`/`/new` 取消，审批按取消处理，agent 收到拒绝/取消的结果。
- 请求发不出去（QQ 断线等）时 fail-closed，返回 `unavailable`，不会默认放行。

### 被动回复的次数上限（QQ 平台限制，绕不过去）

QQ 对**同一条入站消息**的被动回复有硬上限：一个 `msg_id` 最多 5 次，第 6 次 API 直接拒绝。这个计数在服务端，没有重置接口，插件层面刷不掉。

qgent 的处理：

1. **同一条消息按 4 次算**（留一次余量），用完这个 `msg_id` 就换下一条最近入站消息——每条新消息都是新的 `msg_id`、新的 5 次。插件缓存最近 6 条，轮换使用。
2. 缓存里的 `msg_id` 都过期/用完时，降级成**主动推送**（不带 `msg_id`）。主动推送另有自己的额度，私聊比群聊更紧，超了就是发不出去。

所以"模型想在一个回合里连发十几条"这件事，平台层面不成立。真需要高频更新，只有两个方向（当前都**没有**实现）：

- **合并发送**：把 1～2 秒内的多次 `qq_send` 合成一条，逻辑上无限、平台只看到一条。
- **流式**（仅私聊）：开一条流原地更新，不占被动回复次数。

对方每多发一条消息，就能多续 5 次额度——这也是为什么"边聊边更新"比"一口气刷完"更现实。

## 参考

- `@tencent-connect/qqbot-nodejs` —— QQ 协议 SDK（中间件、发送、媒体上传）
- `@tencent-connect/dsh-qqbot` —— 会话管理、分段、被动回复限额降级的思路
- `dsh-peer-talk` —— `steer` / `queue` 投递与工具注册的写法

## License

MIT
