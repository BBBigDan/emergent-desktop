# emergent-agent · M0 基座

```
node agent/server.mjs          # → http://127.0.0.1:8788/shell/agent.html
SYS=mock node agent/server.mjs # 工具返回固定假数据（截图 / 自测要可复现）
```

零依赖，只用 Node 内建模块。**没有接真模型，也没有接 k8s** —— 这一版的目标只有一个：
把「模型发工具调用 → 工具执行 → 场景指令下发 → 手势意图回灌 → 审批挂起」这条链路跑通，
从而**把协议定下来**。

之后换真模型只改 `model.*.mjs`，换真工具只改 `tools.mjs` 里的 `run()`，协议一个字都不用动。

## 为什么下行 SSE、上行 POST

这条链路上真正需要"流"的只有服务端 → 客户端：一条工具的执行要分 `run` / `ok` 两次，
模型的话要逐句来，场景指令要能排队。上行是低频率的点击和输入，POST 就够。

SSE 是 HTTP/1.1 上最省事的流式方案，反代只要 `proxy_buffering off`（配置里已带
`X-Accel-Buffering: no`）。换成 WebSocket 只会多一个 Upgrade 握手和一套心跳要维护。

## 事件

### 下行（`GET /api/events?sid=…`，`text/event-stream`）

| `t` | 字段 | 意思 |
|---|---|---|
| `hello` | `sid model sys tools[]` | 连上了。`tools` 是这一版注册了多少个工具 |
| `turn` | `round kind intent?` | 一轮开始。`kind` = `ask` / `intent` |
| `think` | `on step` | 模型在想。**前端拿它降相干度** —— 不是转圈，是"还没成形" |
| `say` | `text` | 模型说了一句话（一行，≤20 字） |
| `tool` | `id name args state ms note` | `state` = `run` / `ok` / `err` / `denied` |
| `scene` | `op spec ops kind at` | 场景指令，`op` = `set` / `patch` / `pulse` / `transition` |
| `approval` | `id tool args label danger` | 危险工具挂起，等一个 `approve` |
| `approval_done` | `id ok` | 挂起结束（批准 / 拒绝 / 超时） |
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

## 还没做（M1 该换掉的东西）

1. **模型**：`model.mock.mjs` → `model.openai.mjs`（DeepSeek / 任何 OpenAI 兼容端点）。
   接口形状已经对齐，只差 `fetch` 和流式 token。
2. **工具**：`sys_status` / `app_list` / `fs_scan` 的 `run()` 换成真的 k8s API 和真实文件系统。
   `MOCK_*` 常量全部删掉。**schema 不用改。**
3. **流式 token**：现在 `say` 是一整句到达。真模型要按 SSE 分块推，前端得支持"同一行字追加"。
4. **鉴权**：`/api/*` 在 `nginx.conf` 里没校验。要接 authelia 的 forward-auth
   （`authelia-backend-svc:9091/api/verify`，无 cookie 返 401，已实测）。
5. **审计**：每次工具调用落 `~/Agent/audit/*.jsonl`，返回值脱敏（抹 JWT / Bearer 形状）。
6. **`/api/debug` 要关掉**：它现在把整个会话消息原样吐出来，只该在 dev 开。
7. **会话持久化**：内存 Map，进程重启就没了。M1 先落 jsonl，M3 再接记忆层。
