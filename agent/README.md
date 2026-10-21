# emergent-agent · 协议 + 真模型 + 真集群

```
node agent/server.mjs                    # 读 agent/.env，默认硅基流动 + 直连 Olares
MODEL=mock node agent/server.mjs         # 不联网，用假模型跑协议
SYS=mock node agent/server.mjs           # 工具返回固定假数据（截图 / 自测要可复现）
SYS=host node agent/server.mjs           # 退回读本机 /proc（没有集群凭据时自动退回）
```

零依赖，只用 Node 内建模块。**模型是真的，数据也是真的**：`sys_status` 读的是那台
Olares 的 Prometheus，`app_list` 读的是它的 k8s API，`logs_tail` 读的是它的容器日志。

**agent 不是页面，是桌面的一层。** 根路径 `/` 给的是桌面壳，agent 由
`shell/src/deskagent.js` 挂在桌面自己的粒子场上：鼠标贴到底边、或双击桌面空白唤出，
场就地展开（同一批粒子从环境形态凝成界面），Esc 收起、散回球面。
`shell/agent.html` 还留着，但它只是"把场单独拿出来看"的调试页（`?dev=1` 才显示观察窗）。

这一版证明的是那条链路：模型发工具调用 → 工具执行 → 场景指令下发 → 手势意图回灌 → 审批挂起。
换数据源只改 `sources/`，协议一个字都不用动。

## 三个文件分掉了三件事

| 文件 | 管什么 | 换它意味着 |
|---|---|---|
| `model.openai.mjs` | 怎么跟模型说话（OpenAI 兼容） | 换厂商 / 换模型 |
| `prompt.mjs` | 模型知道什么（场语法、说话纪律、手势语义） | 调"它怎么想" |
| `scene.schema.mjs` | 模型**不许**做什么（白名单、截断、clamp） | 调"它最多能干什么" |

第三件是最容易被忽略的：接上真模型之后，`spec` 就不再是"我写的对象"，而是**外部输入**。
没有这一层，模型把 `value` 写成 71 会被 `clamp` 成 1 —— 仪表显示满格，
界面上看不出是谁的错，只会觉得这系统不准。所以校验层做两件事：**挡住**，然后**如实回报**
（`dropped` / `adjusted` 作为工具结果回给模型，否则它会在同一个错误上重复八次）。

## 长期记忆（M2）

`memory.mjs`（抽取 / 回忆 / 巩固）+ 一个**图存储**。它做三件事：

1. **抽取**：一轮问答结束后，让主模型把"值得长期记住"的东西写成 1~3 条事实
   （偏好 / 做过的事 / 因果 / 认得的东西）；读数、寒暄、计划都不记。
2. **回忆**：下一轮开头按用户这句话去图里定向取几条，拼进系统提示。
   不是 dump 全库 —— 7B 的窗口撑不住，而且它会开始复述过去。
3. **巩固**：每 6 轮（或 6 小时）算一次五信号，剪掉没人再碰的，把反复同框的实体
   塌缩成摘要节点，拍一张快照。

存储有两份实现，**方法完全一样**（上层不知道下面是谁）：

| 实现 | 用在哪 | 是什么 |
|---|---|---|
| `sources/graph.axolotl.mjs` | 集群（默认） | HTTP 调侧车 `memsvc/server.py` → Rust 图引擎 axolotl，`.axeb` |
| `sources/graph.mjs` | 本地开发 / 自测 | `node:sqlite`，零依赖备胎 |

```
MEMORY_STORE=axolotl   # 集群默认；侧车不在就**停用记忆**，不退回 SQLite（防记忆分叉）
MEMORY_STORE=sqlite    # 本地跑：node agent/server.mjs（没有 Linux wheel 也能测逻辑）
MEMORY_STORE=auto      # 先试侧车，失败退回 SQLite（默认值）
```

| 位置 | 内容 |
|---|---|
| `~/Agent/memory/memory.axeb` | 图：fact / entity / community 三类节点 + `about` 边（axolotl 二进制） |
| `~/Agent/memory/memory.db` | SQLite 版（迁移后改名 `.migrated`） |
| `~/Agent/memory/snapshots/` | 快照，留最近 5 份 |
| `GET /agent/api/memory?q=n8n` | 当前 stats + 一次回忆 —— **唯一可观测入口** |
| `GET /agent/api/memory?sweep=1` | 顺手做一次巩固（剪枝 / 社群合并 / 快照），返回报告 |

环境变量：`MEMORY=0` 关掉；`MEMORY_DIR=/path` 指定目录；`MEMORY_URL` 侧车地址（默认
`http://127.0.0.1:7801`）。

工具：`memory_recall`（查）/ `memory_stats`（看有什么）/ `memory_forget`（忘，danger 过审批）。
抽取失败只丢那一轮；侧车不可用时记忆停用，桌面照常（**不会**偷偷退回 SQLite）。

自测（不需要模型、不需要集群、不需要侧车）：

```
node agent/memory.test.mjs        # 用 SQLite 那份跑全部逻辑
```

侧车的接口、wheel 怎么重建、怎么排障：见 `deploy/README.md` 的"记忆侧车（axolotl）"。

## 自造工具（M4）

不可能给每个应用写适配器。所以给它一套"读文档 → 写脚本 → 试跑 → 装起来"的流程，
产物是**用户能在 Files 里打开、改、删的普通文件**：

```
~/Agent/tools/<name>/manifest.json    叫什么、要什么参数、要碰什么（needs）、版本
~/Agent/tools/<name>/run.mjs|run.cjs  脚本，只用 node 内建模块
~/Agent/tools/<name>/history/         旧版本（改了代码就归档，可回滚）
~/Agent/skills/<slug>.md              "该怎么做"，会进系统提示
~/Agent/audit/tools-<day>.jsonl       每次调用一行：谁、什么参数、多久、成没成
```

| 工具 | 干什么 |
|---|---|
| `web_get` | 读一个 http 文档（造工具之前先看） |
| `tool_write` | 起个头：名字 / 说明 / 参数表 / net + fs（都可以不填），**落成草稿** |
| `tool_code` | 单独贴脚本（只有 name + code 两个字段） |
| `tool_try` | 试跑一次（danger，过审批；审批前系统会把代码铺到屏幕上） |
| `tool_keep` | 注册，之后每轮工具表里都有它（danger） |
| `tool_list` | 已装的 + 草稿 |
| `skill_save` | 记一页"以后就这么办" |

**三处不由模型决定的地方，也是这层的全部价值：**

1. **草稿不是工具。** `tool_write` 只落盘（`manifest.json` 里 `status: draft`），
   下一轮的工具表里没有它。只有 `tool_keep`（用户点过头）之后才注册。
   改一个已发布的工具，状态自动退回 draft —— 改了代码就得重新看一眼。
2. **域名清单由运行时强制，而且它有两个来源**（`agent/tools/guard.mjs`，靠
   `node --import` 先于脚本执行）。生效的清单 = `manifest.needs.net` ∪ **从代码里读出来的
   完整 URL**（只对 `level: confirm` 生效）。两个来源都会摆到审批卡上：卡片上写的是
   "这一次真的能连哪些"，不是"模型说它能连哪些"。
   **读不出来的地址一律拒** —— 拼出来的域名（`['evil','example','org'].join('.')`）
   不会出现在卡片上，也就进不来。这是护栏真正挡的东西：不是"它想连什么"，
   而是"卡片没说的那一部分"。
   文件：`fs` 三套 API（同步 / 回调 / promises）全部包住，路径不在 `needs.fs` 里直接抛，
   `rename(from,to)` 两个参数都要过。进程：`child_process` / `process.binding` /
   `process.dlopen` 一律禁。子进程环境只给 `PATH / HOME / TZ / EM_TOOL_ARGS / EM_TOOL_NEEDS` ——
   给全了等于把集群令牌一起递过去。
   `tool_keep` 时会把读出来的域名落进 `manifest.needs.net`，之后再跑就不用推断了；
   用户翻 `~/Agent/tools` 也能看到它要连哪儿。
3. **每次调用进审计。** 自造工具是这台机器上唯一"行为不预先确定"的东西。

它不是沙箱。同一进程里的 JS 总能绕（`process.mainModule` 之类），
它把"偷偷连一个域名"从一行 `fetch` 变成"对着要给人看的 manifest 撒谎"。
这是**知情**级别的防护，真隔离得上容器，那是另一件事。

**为什么代码要单独发**（`tool_code` 而不是 `tool_write` 一把梭）：
实测 7B 让它在一个 JSON 里同时写 `params` 和三十行脚本，它会**静默地**只发
`name/description/params`，`code` 根本不在参数里 —— 然后重试十次都一样，
屏幕上只看到"少了必填参数 code"。拆成"元数据"和"代码"两步之后，
最难的那一步只剩一个字符串字段。

自测（不需要模型、不需要集群）：

```
node agent/tools/forge.test.mjs   # 31 项：拼出来的域名被拒、越权文件被拒、代码里读得到的放行、
                                  # 超时被杀、版本与审计、忘填参数时兜底、扁平 needs 与继承
```

（Pod 里也能跑：`kubectl exec … -c agent -- sh -c 'cd /app && node agent/tools/forge.test.mjs'`，
顺便验证 Linux 上的路径守卫。）

## 数据从哪来（`sources/k8s.mjs`）

不调 `kubectl`，直接用 `node:https` 打 k8s API。三个理由：零依赖（kubectl 是 60MB 二进制，
而这个仓库的约定是部署时什么都不用装）、一条链路够用（API 的 service proxy 让我们用一个
HTTPS 端点就能访问集群内任何 Service，Prometheus 就是靠它）、同一份代码在两种部署下都能跑。

| 要什么 | 从哪读 |
|---|---|
| 此刻的 CPU / 内存 / 磁盘 | Prometheus 瞬时查询（node-exporter 的 15s 采样） |
| 这一小时的走势 | Prometheus `query_range`（60 点） |
| 谁在吃内存 | `container_memory_working_set_bytes`（**不是** `kubectl top` —— 这个集群没装 metrics-server，实测 `top` 直接报 "Metrics API not available"） |
| 应用是什么状态 | k8s API 的 deployment / pod 对象（Prometheus 不知道"应用"这个概念） |
| 日志 | `.../pods/<pod>/log?container=<c>`，先滤掉 linkerd-proxy 这类 sidecar |

**凭据**按"越靠内越优先"找：in-cluster 的 serviceaccount → `KUBECONFIG` / `agent/.kube/config`。
k3s 写的 kubeconfig 里 `server` 是 `127.0.0.1:6443`（那是集群内视角），从外面用时
用 `KUBE_SERVER=https://<公网IP>:6443` 覆盖。

> `agent/.kube/` 已在 `.gitignore` 里。那里面是**客户端私钥**，
> 推上去等于把整台机器的 root shell 交出去。

## 配置

`agent/.env`（已在 `.gitignore` 里，不会提交）：

```ini
MODEL_KEY=sk-...                          # 必填（MODEL=mock 时不需要）
MODEL=Qwen/Qwen2.5-7B-Instruct            # 默认落在 ¥0 那一列；mock = 不联网
MODEL_BASE=https://api.siliconflow.cn/v1  # 换厂商只改这一行
SYS=k8s                                   # k8s 读集群 / host 读本机 / mock 用固定假数据
# CTX_PAD=3000                            # 调试：故意把上下文撑大，量"多长算太长"。默认 0
# OLARES_USER=bbbigdan                    # 不填就从命名空间后缀自动推断
# PROM_NS=kubesphere-monitoring-system    # Prometheus 在哪个命名空间
```

`SYS` 和 `MODEL` 是**两件事**，刻意分开：`SYS=mock MODEL=<真模型>` 能在可复现的假数据上调
提示词，`SYS=k8s MODEL=mock` 能在真数据上验工具。混成一个开关就没法分开排障。

### 硅基流动的实测记录（2026-10-21）

- 接口通，key 有效，`/v1/models` 能列出 98 个模型。
- **但所有模型都返回 `402 code 30001 account balance insufficient`** —— 包括标着"免费"的那些。
- **这条是怎么来的（重要，别再踩）**：账户余额本来是 0（或赠金已过期），
  ¥0 的模型还能跑；探测时混进了四个收费模型（`DeepSeek-V4-Flash`、`GLM-5.3-Flash`、
  `Qwen3.5-9B` 等），每个只跑了几百 token、合计不到一分钱 —— 但余额是 0，
  扣费异步结算后变成负数，触发「现金余额 < 0 → 停止该账户的全部 API」，
  **于是几分钟后连 ¥0 的 Qwen 也开始 402**。
  名字里带 `Flash` 不代表免费，这是这次最贵的一课。
- 解锁办法：实名认证 + 充值任意金额（0.01 元即可），之后扣费顺序变成「现金 → 券」。
- 已把默认 `MODEL` 改成 `Qwen/Qwen2.5-7B-Instruct`（¥0），并在
  `tools/dev/probe-model.mjs` 里做了硬保护：探到非免费名单的模型会直接拒绝，
  必须显式 `--paid`。

能用的时候实测延迟（带工具调用）：`Qwen2.5-7B-Instruct` ~0.9s/步最稳；
`DeepSeek-V4-Flash` ~1.1s/步且会并行发调用（收费）；`GLM-5.3-Flash` ~3s/步（收费）；
`Qwen3-8B` 首次调用 90s（冷启动）。

### 免费模型的实测：它们会"看"，但不可靠地"画"

同一句「机器怎么有点卡」，各跑三轮：

| 模型 | 延迟/步 | 结果 |
|---|---|---|
| Qwen2.5-7B | 0.9s | 调工具、铺屏都会，但常补旁白；约三分之一回合完全不铺 |
| Qwen3.5-4B | 15s | 三步走完、数字真实，最完整；但慢 |
| Qwen3.5-9B | 6s | 时好时坏，有一次只看了一个指标就停 |
| GLM-4-9B | 0.5s | 只看数据、写一段长解释，从不铺屏 |
| Xing-29B | 2s | 结构对，但会把 `ask` 写成字符串，偶尔把工具调用写成 `<tool_call>` 文本 |

结论与对策写在 `docs/场界面-设计与接口.md` §9，三层：

1. **接口分层**：默认用高层 `scene_show`（字段全平、不用 id/kind），
   六编码器的 `scene_set` 留给强模型。
2. **系统兜底**：模型看完数据没铺屏时，`defaultOverview()` 用真实读数铺一屏。
3. **规则进代码**：手势 `adjust` 回合里 `danger` 工具直接拒绝；
   整屏判重、每轮最多两屏、问完即停。

默认模型因此仍是 `Qwen2.5-7B-Instruct`（快，配合兜底已经够用）。
换成更慢但更会画的 `Qwen/Qwen3.5-4B` 只需改 `MODEL`，代码不用动。

### 没有余额怎么继续开发

`tools/dev/stub-openai.mjs` 是一个本地 OpenAI 兼容桩，把"模型"这一端固定下来：

```
node tools/dev/stub-openai.mjs            # :8790，按脚本回放
node tools/dev/stub-openai.mjs --bad      # 故意吐非法 spec（验校验层）

MODEL=stub MODEL_BASE=http://127.0.0.1:8790/v1 MODEL_KEY=x node agent/server.mjs
```

它还有一个用处：把收到的请求原文落到 `.tmp/stub-req.jsonl`，
于是"我们到底给模型喂了什么"是可以 grep 的 —— 验 `intent` 这类私有字段没漏出去，
靠的就是这个。

## 为什么下行 SSE、上行 POST

这条链路上真正需要"流"的只有服务端 → 客户端：一条工具的执行要分 `run` / `ok` 两次，
模型的话要逐句来，场景指令要能排队。上行是低频率的点击和输入，POST 就够。

SSE 是 HTTP/1.1 上最省事的流式方案，反代只要 `proxy_buffering off`（配置里已带
`X-Accel-Buffering: no`）。换成 WebSocket 只会多一个 Upgrade 握手和一套心跳要维护。

## 事件

### 下行（`GET /api/events?sid=…`，`text/event-stream`）

| `t` | 字段 | 意思 |
|---|---|---|
| `hello` | `sid model sys tools[]` | 连上了。`model` 是当前用的模型名（`mock:v1` / `sf:<模型id>`） |
| `resume` | `scene ops line` | 会话已有内容：把上一屏原样还回去。**不发动画** —— 用户没发起任何事 |
| `turn` | `round kind intent?` | 一轮开始。`kind` = `ask` / `intent` |
| `think` | `on step` | 模型在想。**前端拿它降相干度** —— 不是转圈，是"还没成形" |
| `say` | `text` | 模型说了一句话（一行，≤20 字） |
| `tool` | `id name args state ms note` | `state` = `run` / `ok` / `err` / `denied` |
| `scene` | `op spec ops kind at` | 场景指令，`op` = `set` / `patch` / `pulse` / `transition` |
| `approval` | `id tool args label danger` | 危险工具挂起，等一个 `approve` |
| `approval_done` | `id ok` | 挂起结束（批准 / 拒绝 / 超时） |
| `error` | `message` | 模型/网络出错。前端要**在场里说一句短话**（`模型账户没余额`），不能只写日志 |
| `note` | `message` | 系统级提示（例如"模型重复了同一组调用，已中止这一轮"） |
| `usage` | `ctx turn session day price limit cap final?` | token 账本。每步一次，轮末一份带 `final`（见「token 账本」） |
| `busy` | — | 上一轮没结束，这次请求被丢掉 |
| `idle` | — | 一轮结束 |

### 上行（`POST /api/send`，body 带 `sid`）

| `t` | 字段 | 意思 |
|---|---|---|
| `ask` | `text` | 用户说了一句话 |
| `intent` | `intent` | 用户动了一下手（`adjust` / `pick` / `tap` / `pan`） |
| `approve` | `id ok` | 对挂起的审批给答复 |

`intent` 的 payload 就是 `gesture.js` 产出的那一份 —— 服务端不解释坐标，只解释语义：

```jsonc
{ "kind": "adjust", "target": "mem", "label": "内存", "from": 0.60, "to": 0.34, "delta": -0.26 }
```

## 状态不丢：会话落盘与恢复

这套界面的状态几乎全在"场"里 —— 刷新一下、反代重启一次，用户看到的就是一片空粒子，
刚才那屏和那行结论全没了。而那一屏往往是他正在看的东西，不是可以随手丢掉的过程。

所以每轮结束（`idle`）落一次盘：`agent/sessions/<sid>.json`，存三样 ——
对话（模型的上下文，只留最近 40 条）、**最后一屏**（眼睛看到的）、最后的读数（兜底要用）。
`sid` 存在 `localStorage`，刷新 / 新标签页都是同一段会话。

三个必须注意的地方：

1. **`patch` 要跟着存。** 只存 `set` 的那份 spec，恢复出来是"换问题之前"的那一屏 ——
   比空白更让人困惑。所以 `postOps` 记下最后几次 patch，恢复时先 `set` 再 `patch`。
2. **恢复不能有动画。** 用户没发起任何事，画面应该"已经在那儿"；重放一次溶解重组，
   等于告诉他"刚才发生了什么"。
3. **一个会话可以有多个连接。** 刷新的一瞬间旧连接还没断、新连接已经建好；
   开第二个标签页也是同一段会话。第一版是"新连接踢掉旧连接"，两个页面就会互相
   踢成 `disconnected` 然后各自重连，永远在打架 —— 现在是 `reses` 集合，广播。

## 首屏不要等模型

一轮里最慢的是模型（免费 7B 约 1~3s/步，三步就是 6~9s）。但**数据是快的**：
`sys_status` + `app_list` 加起来不到 2 秒。所以数据一到就先按真实读数铺一屏
（`defaultOverview`），模型想好之后再盖掉它。

用户看到的是"屏在长"，而不是"盯着一片抖动的粒子等它想"。
实测首屏从 4~9s 降到 **2.7s**，整轮 6.7s。

场里那一行字按字依次长出来（每字 42ms），这是场自己的编码方式，不是假装在流式输出 token；
输入回显走 `instant`，否则打字会像卡住。

## 工具契约

每个工具四件事写死（`tools.mjs`）：名字、给模型看的描述、参数 schema、**危险等级**。

危险等级只有两档，故意不做第三档：

| 等级 | 判据 | 处理 |
|---|---|---|
| `safe` | 只读，或只改变"看见什么"（`scene_*` 全在这档） | 直接执行 |
| `danger` | 会产生后果（写文件、删东西、重启服务） | 过审批门 |

"中间档"是所有权限系统烂掉的开始 —— 一旦有"半危险"，判据就模糊了。

## 审批门只有一条规则

> **用户通过分叉给出的明确选择，就是对那个动作的批准。**

已经点过"压到 34%"的人，不该再被问一次"确定压到 34% 吗"——那不是在保护他，
是在确认他没读过自己刚点的东西。所以：

- 手势 `pick` 触发的危险工具 → **直接做**（`needsGate()` 返回 false）
- 模型自己拿的主意（用户只说了"内存有点高"）→ **走审批**

审批 UI 复用场里那个分叉（`patch` 换文案），没有分叉时才退到 DOM 带子。
审批是**系统的 affordance**，不受模型表达自由支配 —— 所以它允许不是粒子。

## 两个防跑飞的阈值

| 机制 | 值 | 为什么 |
|---|---|---|
| `MAX_STEPS` | 5（这一轮动了造工具才放宽到 8） | 一轮最多几次模型往返 |
| 重复调用检测 | 同一组 `name:args` 连着来 2 次就停 | 多跑的那几次会把同一个动画重播八遍，用户看到的是"东西在抽"，不是"在思考" |
| `APPROVAL_MS` | 90s | 超时按拒绝处理，不无限挂着 |
| `CTX_TRIM_AT` / `CTX_TRIM_TO` | 78% → 45% | 上下文到线就丢最老的一段（见下） |
| 429 退避 | 1s / 3s / 7s，共 3 次 | 免费模型的限流窗口是"每分钟 N 次"，500ms 重试等于没重试 |

**5 而不是 8**：8 是给造工具留的（写元数据 → 贴代码 → 试跑 → 改 → 装）。普通问答
用不到，实测一轮"机器怎么样"翻了 8 次，其中两次是被服务端拒掉的调用，有效工具只有 3 个。
每多一步就是**多一次整份上下文**（9.4k 起）—— 8 步就是 10 万 token 输入。
判据写在代码里（看到 `tool_*` / `skill_save` 被调用才放宽），不靠模型自己声明。

## token 账本（`usage.mjs`）

**看不见的东西管不住。** 这个文件回答三个问题，三份数字都来自同一份 `usage`：

| 问 | 字段 | 从哪来 |
|---|---|---|
| 当前上下文有多大 | `ctx.tokens / limit` | 最后一次调用的 `prompt_tokens` |
| 刚才那一轮花了多少 | `turn.in / out / calls / cached` | 本轮所有调用**累加** |
| 今天一共多少 | `day.in / out / cost` | `agent/usage/<日期>.json`，跨会话累计 |

前两条进 SSE 的 `usage` 事件（每步一次 + 轮末一份 `final`），第三条落盘。手工查：
`GET /agent/api/usage?sid=<sid>`。界面上是 `?dev=1` 时右下角那个角标。

### 四条实测结论（真模型 + 真集群，2026-10-21）
1. **`prompt_tokens` 就是上下文大小**，不要自己累加历史。每次请求都把
   system + 记忆注入 + 全部消息重发一遍，所以最后一次的 `prompt_tokens`
   恰好是"现在占了多少窗口"。累加反而会因为重试、裁剪、注入而算错。
2. **一轮 8 步 = 10 万 token 输入**，是单次上下文（12k）的 8 倍。
   账本上 `turn.in` 远大于 `ctx.tokens` 不是 bug，是**多步任务的真实成本**——
   这也是"别让模型原地打转"的经济理由。
3. **上下文的大头不是历史，是工具表和系统提示词**。34 个工具的 JSON schema
   占 6.3k，系统提示词 5.9k，而一整轮对话的历史只有 1.5k。
   所以在 `MAX_STEPS` 和"裁历史"上省下的都不多 —— 要省得先裁工具表。
4. **缓存命中是真实存在的**：`cached` 实测占输入的一半（64k/104k）。
   同一份 system + tools 连着发，服务端会命中前缀缓存。

### 上下文是怎么从 12.4k 降到 9.4k 的

| 手段 | 省了多少 | 代价 / 判据 |
|---|---|---|
| 造工具的规程（1500 token）不进常驻提示词 | −1270 | 靠 `coldAllow()` 的关键词决定发不发；漏判的代价是"它说做不到"，所以关键词宁可宽 |
| 造工具那 6 个工具按场景发（`TOOL_GROUPS`） | −1290 | 同上，两组共用一次判断 |
| `scene_set` 与 `scene_transition` 合并成 `scene_set{op}` | −400 | 少一个工具要选；旧的 `scene_transition` 保留为 hidden，`exec` 仍认 |
| `sys_status` 连应用状态一起返回，`app_list` 变 hidden | 整整一步 | 单次返回多 100 token，换来少一次 9.4k 的完整重发 |
| 一轮步数 8 → 5 | 整轮 −40% | 造工具那轮仍给 8 步 |

**不要把这些省下来的钱花在"再砍一刀"上。** 再往下砍就得动工具集本身
（比如按模型能力只给 7B 12 个平铺动词），那会改变模型能做对什么，
需要一整轮回归才能确认没退化 —— 而在那之前，5 步 × 9.4k 已经是原来 8 步 × 12.4k 的 40%。

### 两条纪律

- **没有单价就不算钱。** 查不到的模型 `price: null`，界面写"单价未配置"，
  绝不能填 0 —— "¥0.0000" 和"免费"在屏幕上长得一样，含义完全不同。
  价格会变，所以只在表里放**确定是 ¥0** 的模型，其余走
  `MODEL_PRICE_IN` / `MODEL_PRICE_OUT`（元/百万 token）。
- **估算值必须自己承认。** mock 模型、本地桩、某些网关不回 `usage`，这时按字数推
  （CJK 一字一 token，其余四字符一 token），并打 `est: true`，界面上带 `~`。
  估算值和账单长得一样，是这个功能最坏的失败方式。

### 可调项

```bash
# MODEL_CTX=32768            # 上下文窗口。不填按模型名查表，查不到落 32768 并标 `?`
# MODEL_PRICE_IN=4           # 元/百万 token，两个一起给才生效
# MODEL_PRICE_OUT=16
# TOKEN_DAY_CAP=2000000      # 今日 token 上限。到了直接拒下一轮（默认不限）
```

`TOKEN_DAY_CAP` 是**开跑前**拦的，不是跑完再报 —— 限额的意义就是不让它开始。

### 还没做

**上下文满了不会自己收。** 现在只能看见水位（≥75% 变暖色），没有策略：
到了 90% 该裁历史、还是该把旧工具摘掉、还是该换更小的工具表，都还没定。
在这之前它表现为"模型开始忘掉前几轮"，而观测之前的排查全靠猜。

## 怎么量它有没有变蠢（`tools/dev/eval-llm.mjs`）

```bash
SYS=k8s MODEL=Qwen/Qwen2.5-7B-Instruct PORT=8788 node agent/server.mjs &
node tools/dev/eval-llm.mjs        # 五道常问题，每题一个干净 sid
```

五列对应五种坏法：**步数**（越贵）、**无效调用**（被拒 / 参数坏）、**工具序列**（乱调、绕路）、
**输出通道**（一声不吭是最严重的失败）、**输入**（本轮 token）。

### 上下文长度到底有没有影响：三点对照（2026-10-21）

用 `CTX_PAD` 在系统提示词后面追加无关占位文字（不改任何规则），同一组题各跑一遍：

| 上下文 | 平均步数 | 工具选择 | 完成 |
|---|---|---|---|
| 9.4k | 2.0 | sys_status / fs_scan / memory_recall | 3/5（另 2 题被限流） |
| 12.4k（+3k 无关文字） | 2.0 | **完全相同** | 3/5 |
| 23k（+14k 无关文字） | 2.0 | **完全相同** | 3/5（后 2 题 429） |

**结论：在 9~24k 这个区间里，上下文长度对 7B 的行为没有可测量的影响。**
真正让它从"8 步乱调"变成"2 步做完"的是三件设计上的事，不是长度：
合并 `sys_status`+`app_list` 少了一个可乱调的工具、步数上限收到 5、坏了参数不再给
"去调 tool_write"的错误建议。

**这条要先量再下结论。** 没有 `CTX_PAD` 和这五道题，"上下文太大了所以变蠢"永远只是感觉 ——
而按这个感觉去砍提示词，很可能砍掉的正是让它做对的那几句。

### 已知的真问题：免费模型限流

连跑 15 题之后开始出现 `429 Request was rejected`。免费模型的速率限制很紧，
它不是"变蠢"，但表现出来一样（这一题毫无反应）。评测脚本会把 429 单独标出来，
不算进"变蠢"的账里。

## 上下文满窗自收（`history.mjs`）

32k 窗口里固定开销（系统提示 4.8k + 工具表 4.6k）已经占了三成，十几轮就能吃满。
吃满时接口直接 400 —— 而且**报错发生在工具跑到一半**，用户看到的是"做了一半不动了"，
比一开始就拒绝还难理解。所以到线之后由服务端自己丢最老的一段。

三条写进测试的规矩（`node agent/history.test.mjs`）：

1. **切点必须落在 `user` 上。** `assistant(tool_calls)` 和随后的 `tool` 结果是一条
   消息链，切断任何一处下次请求直接 400，而且报错长得像"模型接口坏了"。
   一轮对话总是从 `user` 起头，从它切天然完整。
2. **第一条 system 永不裁。** 丢了它就是丢身份和全部规则。
3. **固定开销本身就超过目标水位时，不假装裁过了。** 返回 `cramped`，上层如实说
   "系统提示和工具表本身就把窗口占满了" —— 那时候该做的是裁工具表，不是裁历史。

不摘要：摘要要再调一次模型，而**那次调用的上下文本来就是满的**。
要做也应该在后台做，不挡这一轮（还没做）。

## 限流（429）怎么处理

`model.openai.mjs` 里 429 单独一条路：先听 `Retry-After`，没有就 1s / 3s / 7s 退避
（加 0~400ms 抖动，避免多个连接整齐地一起回来），一共 3 次。仍失败就抛一个带
`limited` 标记的错误 —— 前端说"模型那边限流了，等会儿再问"，而不是把 429 原文糊到脸上。

**为什么值得单独写一条**：限流的表现和"变蠢"一模一样（这一题毫无反应）。
不把这两件事分开，排查会一直往模型能力上想。`node agent/model.retry.test.mjs` 用假服务端
把退避、上限、标记三件事都钉住了。

## 还没做

1. **用户目录依赖 `FS_ROOT`**：`fs_scan` 读的是宿主机的 `/olares/rootfs/userspace`
   —— 和 Files 应用**同一个目录**，所以看到的是真文件。没挂上时如实返回"看不到文件"，
   绝不猜文件名（用户会照着假列表去删东西）。文件**写操作**（移动 / 删除）还没接。
2. **写操作**：`mem_trim` 在真集群上同样只返回"没接"。真机上"把内存压到某个比例"
   没有对应的系统动作，能做的只有重启应用，而重启**不保证**压到目标值。
   接之前要先想清楚"降内存"到底该是什么原子动作（`rollout restart`？scale 到 0？），
   不要为了链路完整去假装成功。
3. **单 pod 内存取不到时**：`kubectl top` 不可用（没装 metrics-server），
   所以应用内存只能靠 Prometheus 的 `container_memory_working_set_bytes`。
   这台机器上它好用；换集群如果没有 node-exporter / cAdvisor，应用列表会没有内存数。
4. **流式 token**：现在 `say` 是一整句到达。真模型要按 SSE 分块推，前端得支持"同一行字追加"
   （现在的"逐字生长"是渲染动画，不是真流式）。
5. **鉴权**：`/api/*` 在 `nginx.conf` 里没校验。要接 authelia 的 forward-auth
   （`authelia-backend-svc:9091/api/verify`，无 cookie 返 401，已实测）。
6. **审计**：每次工具调用落 `~/Agent/audit/*.jsonl`，返回值脱敏（抹 JWT / Bearer 形状）。
7. **`/api/debug` 已默认关闭**（需要 `DEBUG=1` 启动）。它会把整个会话消息原样吐出来，
   含系统提示词和记忆注入 —— 线上不该有这个出口。
