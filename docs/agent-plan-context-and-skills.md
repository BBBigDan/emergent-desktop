# 上下文管理 与 系统技能：方案

> **落地状态（2026-10-22 晚）**：P1~P5 都做了。
> · 上下文 → `agent/history.mjs` 的 `compactPlan`/`applyCompact`、`server.mjs` 的
>   `compactSession`/`newSession`，入口 `/compact` 与 `/new`（见 `agent/README.md`）。
> · 技能 → `agent/skills.mjs` + 构建时 `olares-cli skills export`；`skill_use` 按需展开，
>   并且**同时返回 ops**（文档是动词表，op 是能执行的那一小撮）。
> · 系统层 → `agent/olares.mjs` 的 op 从 10 个扩到 16 个（加 appinfo/categories/pods/
>   events/images/backup），形状对着线上真数据单测（`agent/olares.test.mjs`）。
> · 写操作 → 单独的 `olares_act` 工具（danger 级），停/开/重启/装/升级/卸载/取消；
>   实测 navidrome stop→stopped→resume→running。
> 下面保留当初的判断过程，方便回头核对"为什么这么做"。

> 提出的问题（2026-10-22）：
> ① 上下文——用户有「压缩上下文」和「开启新会话」两种需求，新会话怎么落地还没有想法；
> ② 给 agent 的系统管理能力太弱——Olares 本身有很多管理功能和应用，现在只包了 k8s。
>
> 这份是**方案**，不是实现。定稿后再动代码。

---

## 一、现状盘点

### 1.1 已有的 31 个工具（按层）

| 层 | 工具 | 问题 |
|---|---|---|
| 系统（k8s） | `sys_status` `app_list` `k8s_get` `k8s_restart` `logs_tail` | `k8s_get` 不是通用读，是写死的 `diagnose(app)`；模型没法查任意资源 |
| 文件 | `fs_scan` `fs_list` `fs_read` `fs_search` `fs_write` `fs_move` `fs_delete` | 只在用户空间，够用 |
| 记忆 | `memory_recall` `memory_stats` `memory_forget` `mem_trim` | 够用 |
| 表达 | `scene_*` ×6、`surface_*` ×2、`draw` `face` `draw_stop` | 够用 |
| 元工具 | `tool_*` ×5、`skill_save` `tool_list` | 让模型**现写**工具，不是"用技能" |

**核心缺口**：Olares 是"一个跑着一堆应用的个人云"，而 agent 现在只会 `kubectl get pods`。
应用装没装、从哪进、什么版本、能不能备份、磁盘挂哪、谁能访问 —— 一个都答不了。

### 1.2 Olares 的管理面其实是 CRD（已探明）

集群里 `kubectl api-resources` 出来的一批（都在 agent 的 RBAC 范围内，读得到）：

| 资源 | 管什么 | 对应用户问题 |
|---|---|---|
| `applications.app.bytetrade.io` | 已装应用：`state`、`entrances[].host`、`icon`、`namespace`、`settings`、`tailscale` | "我装了哪些""怎么进不去" |
| `appimages.app.bytetrade.io` | 市场里的应用定义（可装什么、版本） | "能不能装个 xx" |
| `applicationmanagers` | 安装/升级/卸载任务与进度 | "怎么一直转圈" |
| `backups` / `restores` / `snapshots`（`sys.bytetrade.io`） | 备份、恢复、快照 | "有没有备份""帮我备一份" |
| `terminus` / `sharedrouteregistries` | 入口、域名、证书、反代 | "为什么域名打不开" |
| `applicationpermissions` / `sharesambas` | 应用权限、SMB 共享 | "谁能看我的文件" |
| `appenvs` / `userenvs` / `systemenvs` | 应用/用户/系统环境变量 | "改个配置" |
| `middlewarerequests` / `pgclusters` / `redixclusters` | 中间件实例 | "数据库在哪" |
| `gpubindings` | GPU 分配 | "谁在占显卡" |
| `fswatchers` / `providerregistries` | 文件监听、provider 注册 | 排障 |

**结论**：不需要去猜 `bfl` 的 HTTP 路径（实测 `bfl/api/*` 全是 404），
也不依赖 `dashboard-service` 的内部接口 —— **CRD 就是 Olares 的管理面**，
而 k8s 访问已经通了（`sources/k8s.mjs`，一个 HTTPS 端点）。

这是这次方案里最重要的一条：**能力不用新开通道，缺的是语义层**。

---

## 二、上下文

### 2.1 两种需求不是一件事

| | 压缩上下文 | 开启新会话 |
|---|---|---|
| 目的 | **同一件事聊得太长**，要腾地方继续聊 | **换一件事**，别被前面带着走 |
| 会话 id | 不变 | 换新 |
| 屏幕上 | 内容还在（可能换一页） | 清空 |
| 记忆 | 不动 | 不动（**这正是"新会话"≠"失忆"**） |
| 上一段 | 变成摘要，仍在上下文里 | 变成**一条记忆**，靠 recall 取 |
| 用量账本 | 不清（日账本跨会话） | 不清 |

一句话：**压缩是"记得更少但还在聊"，新会话是"不聊了，但我记得我们聊过"。**

### 2.2 压缩

现状：`history.mjs` 在 78% 时**直接丢**最老的消息（切点必须在 `user`），丢到 45%。
它解决的是"接口 400"，不是"用户想继续聊"。

改法：**先摘要，再丢**。

```
水位 < 60%    什么都不做
60~78%        （可选）后台预压缩：把 30% 以前的消息摘要成一段，替换进去
≥ 78%         同步压缩（挡住这一轮之前完成）；压缩失败才回落到现在的"丢"
```

三条纪律：

1. **摘要在后台做，不挡当前轮**。用满窗的上下文去省上下文是最贵的省法（`history.mjs` 里已经写过这条）。
2. **摘要必须标身份**：替换进去的那条消息前坠「（以下是更早的对话摘要，不是原话）」。不然模型会把摘要当事实引用，而我们**不允许模型自己的话当事实**。
3. **摘要里只留三类东西**：用户明确说过的结论/偏好、已经做过的动作及其结果、还没做完的事。**不留**读数、不留模型的推测。

用户怎么触发：
- 水位条可点（悬停提示「压缩上下文」）；
- 或者直接说「压缩一下」（`mem_trim` 已有类似语义，可以合并）；
- 压缩过程显示在状态条上（水位条变成"正在收"）。

落地位置：`history.mjs` 加 `summarize(messages, o)`，`server.mjs` 在 `trimHistory` 之前调。

### 2.3 新会话（这是要定的部分）

三个动作，缺一不可：

**① 把上一段压成一条 episode 写进记忆**

```
{ kind: 'episode', at: 时间, title: '磁盘排查', body: '用户问磁盘，查到 n8n 日志两周涨 3.2G，建议 7 天轮转，用户还没动手。' }
```

这样新会话第一句话如果是"上次那个日志"，`memory_recall` 能取到。
**没有这一步，新会话就是失忆**，用户会觉得"它把我刚才说的忘了"。

**② 换 sid、清屏、重建系统提示**

- 新 sid 立即落盘（空会话也要有文件，"刷新回到新会话"才成立）；
- 屏幕上 `scene.clear()` + 答案清空 + 输入行清空；
- 状态条的水位/记忆数字立刻更新（水位归零、记忆 +1）。

**③ 旧会话归档，不删**

`sessions/archive/<sid>.json`。本期只做"可回溯"（命令行/日志能查），
不做会话列表 UI —— 那个属于"历史"面板，和现在的 ↑ 记录是两件事。

**交互入口**（三选一，倾向 2）：
1. 状态条右端加一个图标（和"记录""停止"并排）；
2. **输入框里打 `/new`（或说"开个新会话"）** —— 不占屏幕空间，且和 `/compact` 对称；
3. Esc 长按 800ms —— 容易误触，不推荐。

**首屏说什么**：什么都不说。只留状态条 + 输入行光环。
不打"你好，我是……"的招呼 —— 那是聊天机器人的语法，这套界面里它一直在，不需要自我介绍。

### 2.4 一个必须做的决定

新会话之后，**上一段的摘要要不要塞进新会话的第一条 system**？

- 塞：新会话一开口就知道上下文，但"新会话"就没那么新了，而且会重复占上下文；
- 不塞（推荐）：摘要只进记忆，模型需要时自己 `memory_recall`。
  符合"记忆是相关才取，不是常驻"的纪律。

---

## 三、系统技能：用官方的 `olares-cli`，别自己造

> 你的原话：「去看 olares 官方的 cli、官方 agent、设置、market 等等官方仓库中的程序所具有的能力，去用它们的 API」。
> 我看完了，结论是：**这套能力官方已经做完了，而且做成了给 agent 读的技能包**。自己照着 CRD 猜是重复造轮子。

### 3.1 官方有什么（`beclab/Olares/cli`）

`olares-cli` 是一棵命令树，每个子树都配了一份 `SKILL.md`（Claude 式技能，带 frontmatter）：

| 技能 | 管什么 | 实测 |
|---|---|---|
| `olares-shared` | 地基：profile 模型、登录、token 刷新、401/403 恢复 | ✓ |
| `olares-market` | 应用商店：`list/get/categories/status`、`install/upgrade/clone/uninstall/stop/resume/restart/cancel`、`upload/download/delete`，全部带 `--watch` | ✓ `market list --mine` 返回 name/title/version/source/state |
| `olares-settings` | 设置 SPA 的镜像：`me`（whoami/version/check-update/sso）、`users`（list/get/create/delete）、`apps`（entrance/env/suspend、domain/policy/auth-level）、`vpn`、`integration`（云账号/cookie）、`backup`、`appearance`（壁纸/语言/widget/layout）、`network`（反代/FRP/hosts）、`gpu`/`compute`、`video` | ✓ `settings me version` |
| `olares-cluster` | K8s 运行时：`context`、`pod`（list/get/yaml/events/logs/delete/restart/exec）、`workload`、`cronjob`、`job` | 未全测 |
| `olares-dashboard` | 指标：`overview`（cpu/mem/disk/network/pod/fan/gpu）、`applications`（按应用排名）、时间序列与 NDJSON | ✓ CPU 0.325、结构化 envelope |
| `olares-doctor` | **症状 → 根因**的路由：装卡住 / 崩 / 拉不到镜像 / running 但打不开 / 资源压力 | 未测 |
| `olares-router` | 模型网关：本地 LLM、外部 provider、多模态、用量审计（1.12.7+） | 未测 |
| `olares-files` / `olares-knowledge` / `olares-search` | 文件、知识库下载、全局搜索 | 未测 |
| `olares-chart` / `olares-publish` | 写 chart 并部署、发布到公共市场 | 未测 |

**实测记录**（2026-10-22，线上 pod 内）：

```
$ olares-cli version
npm package: 1.12.8-cli.0  (skills)      ← 技能包就编在二进制里

$ echo '***' | olares-cli profile login --olares-id bbbigdan@olares.com --password-stdin
logged in as bbbigdan@olares.com (profile: bbbigdan@olares.com)
role: Owner

$ olares-cli market list --mine -o json
[{"name":"qbittorrent","title":"qBittorrent","version":"1.0.31","source":"market.olares","state":"running"}, …]

$ olares-cli dashboard overview -o json
{"kind":"dashboard.overview","sections":{"physical":{"items":[{"raw":{"metric":"cpu","total":8,"utilisation":0.325}…
```

二进制 28MB（`olares-cli-v1.12.8-*_linux_amd64`），pod 里直接下载就能跑，无依赖。
**它比我现在手写的 `app_list` / `sys_status` 强**：有版本、有 source、有 categories、有标准化 envelope、有 `--watch` 的进度语义。

### 3.2 落地方式：装进镜像 + 受控 exec + 官方技能

```
agent 镜像
├── /usr/local/bin/olares-cli          28MB，构建时从 release 下载
├── /app/agent/skills/                 olares-cli skills export 出来的 12 份 SKILL.md
└── /app/agent/                       Node
        ├─ olares.mjs                  受控 exec（白名单 + 审计 + 超时）
        └─ skills.mjs                  索引 name+description，按需展开正文
```

**为什么用 CLI 而不是照 SKILL.md 里的 HTTP 直连**：

1. 官方的 SKILL.md 全是 "run `olares-cli market install …`"，它们**教的是 CLI**，
   不是 REST 端点。要直连就得自己去啃 Go 源码里的每个 endpoint，而 CLI 的
   `-o json` 已经把"给人看的表格"和"给脚本的 JSON"分开了。
2. CLI 自己处理了 token 刷新、401 重试、状态机轮询、超时语义（`--watch`）。
   这些重写一遍就是重写一个 CLI。
3. **它自带版本对齐**：`settings` 的 `gpu` / `compute` 是按 Olares 版本切的
   （1.12.5 vs 1.12.6+），这种判断不该由我们的提示词来做。

**必须先解决的冲突**：`guard.mjs` 现在**禁止 `child_process`**（防模型自己写工具时跑任意命令）。
CLI 需要 exec，所以要开一个**唯一的受控出口**：

```js
// olares.mjs —— 全工程唯一允许 spawn 的地方
execFile('/usr/local/bin/olares-cli', argv, {
  timeout: 20_000,
  env: { PATH: '/usr/bin:/bin', HOME: '/data/olares-home' },   // token 存这儿
})
```
三条硬约束：
- **只允许这一个二进制**，argv 由我们的封装拼，不是模型拼字符串（模型只填枚举和名字）；
- 危险动词（`market install/uninstall`、`cluster pod delete/exec`、`settings users delete`）
  走现有的审批门，和 `k8s_restart` 同级；
- 每次调用写审计（命令、耗时、退出码、输出前 200 字），和 `tool_*` 的审计同一条流。

### 3.3 认证怎么办

CLI 要一个 profile（`olaresId` + token）。三条路：

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 密码每次登录 | `profile login --password-stdin` | 密码要托管，且 2FA 时还要 TOTP；**不安全** |
| B. **refresh token 进 Secret**（推荐） | `install.sh` 时让用户粘一次 refresh token → K8s Secret → pod 启动 `profile import` | 可撤销、可轮换；pod 重建自动恢复 |
| C. 复用桌面登录态 | 从浏览器 cookie 里拿 | 跨容器，脆弱 |

选 B。注意 token 落在**空目录 mount 的 `HOME`**（hostPath `state/<user>/olares-home`），
不能落 pod 临时层 —— 否则每次重建都要重新导入。
`profile list -o json` 能读到 auth 状态，状态条可以显示"系统权限：已授权 / 未授权"。

### 3.4 工具表怎么改（上下文是硬约束）

现在 31 个工具吃 4.6k token（32k 窗口的 14%）。**不能把 12 个技能各做成一个工具**。

```
现在（31 个平铺）
  sys_status  app_list  k8s_get  k8s_restart  logs_tail  fs_* ×7  …

改后（约 14 个 + 技能索引）
  读：olares('apps' | 'overview' | 'settings' | 'users' | 'backup' | 'network' | …)
  写：olares('install' | 'stop' | 'restart' | 'uninstall' | …)   ← 审批门
  诊断：olares('doctor', symptom)                                  ← 直连官方 doctor 技能
  技能：skill_use('olares-market' | 'olares-settings' | …)         ← 按需展开 SKILL.md
  保留：fs_*（用户文件，CLI 走 API 不如直接读挂载）、memory_*、scene_*、tool_*
  删掉：app_list / sys_status 的 k8s 实现（改由 olares 提供，数据更全）
```

**技能索引的 token 账**：12 个技能 ×（名字 + 一句话）≈ 300 token 常驻；
展开一份 SKILL.md ≈ 1.2k，只在用到那一刻进上下文，读完即弃（不写回历史）。

这正好是"包装成可以使用的技能"——**官方已经把技能写好了，我们只负责装上、索引、按需展开**。

## 四、分期

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P1** | 镜像装 `olares-cli` + 认证（refresh token 进 Secret）+ `olares('apps'/'overview')` | 问"我装了哪些应用、什么版本、n8n 从哪进"能一次答全；问"机器忙不忙"用 `dashboard overview` 而不是自己算 |
| **P2** | 官方技能索引（12 份 SKILL.md）+ `skill_use` 按需展开 | 常驻上下文只多 ~300 token；问"帮我装个 xx"时它会先展开 `olares-market` 再动手 |
| **P3** | 压缩上下文（摘要，后台） | 聊到 70% 时说"压缩一下"，水位降到 40%，且还能接着上文聊 |
| **P4** | 新会话（episode + 换 sid + 清屏） | 开新会话后问"上次那个日志"，它能 recall 到 |
| **P5** | 写操作（install/uninstall/stop/backup/users）+ 审批门 | 每个写操作有 diff + 确认；危险动词和 `k8s_restart` 同级 |

P1 是地基，也最能立刻改善体验（现在的 `app_list` 连版本号都没有）。
P2 决定了后面所有系统能力能不能"装得下"（上下文）。
P3/P4 是你明确提的两个需求，可以并做。

## 五、还没想清楚、需要拍板的

1. **新会话的旧会话怎么办**：只归档（本期）还是要一个能切回的列表？
2. **压缩用什么模型**：同一个 7B（便宜、但摘要质量一般）还是换一个强模型（贵、但摘要更准）？
3. **`olares` 的写操作边界**：装/卸应用算不算"改世界"？要不要每次都问？
   （现在 `k8s_restart` 是 danger 级，走审批门。）
4. **L3 应用技能的范围**：只做用户装了的（n8n / navidrome / qbittorrent / filebrowser），
   还是要覆盖市场里的全部？
