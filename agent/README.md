# emergent-agent · M0 协议 + M1 真模型

```
node agent/server.mjs                    # 读 agent/.env，默认硅基流动
MODEL=mock node agent/server.mjs         # 不联网，用假模型跑协议
SYS=mock node agent/server.mjs           # 工具返回固定假数据（截图 / 自测要可复现）
```

零依赖，只用 Node 内建模块。**模型已经接真了，工具还是假的**（k8s / 文件系统待接）。

这一版证明的是那条链路：模型发工具调用 → 工具执行 → 场景指令下发 → 手势意图回灌 → 审批挂起。
换真工具只改 `tools.mjs` 里的 `run()`，协议一个字都不用动。

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

## 配置

`agent/.env`（已在 `.gitignore` 里，不会提交）：

```ini
MODEL_KEY=sk-...                          # 必填（MODEL=mock 时不需要）
MODEL=Qwen/Qwen2.5-7B-Instruct            # 默认落在 ¥0 那一列；mock = 不联网
MODEL_BASE=https://api.siliconflow.cn/v1  # 换厂商只改这一行
SYS=host                                  # host 读本机真数字 / mock 用固定假数据
```

`SYS` 和 `MODEL` 是**两件事**，刻意分开：`SYS=mock MODEL=<真模型>` 能在可复现的假数据上调
提示词，`SYS=host MODEL=mock` 能在真数据上验工具。混成一个开关就没法分开排障。

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
| `turn` | `round kind intent?` | 一轮开始。`kind` = `ask` / `intent` |
| `think` | `on step` | 模型在想。**前端拿它降相干度** —— 不是转圈，是"还没成形" |
| `say` | `text` | 模型说了一句话（一行，≤20 字） |
| `tool` | `id name args state ms note` | `state` = `run` / `ok` / `err` / `denied` |
| `scene` | `op spec ops kind at` | 场景指令，`op` = `set` / `patch` / `pulse` / `transition` |
| `approval` | `id tool args label danger` | 危险工具挂起，等一个 `approve` |
| `approval_done` | `id ok` | 挂起结束（批准 / 拒绝 / 超时） |
| `error` | `message` | 模型/网络出错。前端要**在场里说一句短话**（`模型账户没余额`），不能只写日志 |
| `note` | `message` | 系统级提示（例如"模型重复了同一组调用，已中止这一轮"） |
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
| `MAX_STEPS` | 8 | 一轮最多几次模型往返 |
| 重复调用检测 | 同一组 `name:args` 连着来 2 次就停 | 多跑的那几次会把同一个动画重播八遍，用户看到的是"东西在抽"，不是"在思考" |
| `APPROVAL_MS` | 90s | 超时按拒绝处理，不无限挂着 |

## 还没做（M2 该换掉的东西）

1. **工具**：`sys_status` / `app_list` / `fs_scan` 的 `run()` 换成真的 k8s API 和真实文件系统。
   `MOCK_*` 常量全部删掉。**schema 不用改。**
2. **流式 token**：现在 `say` 是一整句到达。真模型要按 SSE 分块推，前端得支持"同一行字追加"。
3. **鉴权**：`/api/*` 在 `nginx.conf` 里没校验。要接 authelia 的 forward-auth
   （`authelia-backend-svc:9091/api/verify`，无 cookie 返 401，已实测）。
4. **审计**：每次工具调用落 `~/Agent/audit/*.jsonl`，返回值脱敏（抹 JWT / Bearer 形状）。
5. **`/api/debug` 要关掉**：它现在把整个会话消息原样吐出来（含系统提示词），只该在 dev 开。
6. **会话持久化**：内存 Map，进程重启就没了。M2 先落 jsonl，M3 再接记忆层。
7. **提示词还没经过真模型检验**：写它的依据是源码里的上限和 `timing.js` 的常数，
   但没有一轮真实对话验证过"模型会不会照着做"。余额恢复后第一件事就是跑这条。
