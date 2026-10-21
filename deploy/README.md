# 涌现式壳层 · 部署与切换

把 `shell/` 跑在 Olares 里，并且保留一键切回官方桌面的能力。

## 为什么不是「改官方 deployment」

直接改 `olares-app-deployment` 或者往它的 `/www` 里塞文件都不合适：`/www` 是 **emptyDir**，
init 容器每次启动都会重新拷贝，pod 一重启我们的文件就没了；而直接换镜像则会把
Files / Market / Settings 这些同 pod 的应用一起带走。

所以这里另起一个 pod，只接管「桌面入口」这一个端口，其余请求全部反代回官方 pod。

```
浏览器
  │  https://desktop.<id>.olares.com
  ▼
envoy ──► Service edge-desktop (80 → 91)
             │  selector 决定去哪个 pod
             ├── app=emergent-shell  →  我们的壳层 pod  ┐  开发版
             └── app=olares-app      →  官方前端 pod    ┘  官方版
```

## 关键设计

| 点 | 做法 | 原因 |
|---|---|---|
| 静态文件 | hostPath `/olares/emergent-shell/www` | 改完 `scp` 即可，不用重启 pod、不用打镜像 |
| 只接管 `/` | nginx `try_files`，`/api` `/server` `/kapis` … 反代到 `olares-app-official:91` | 登录态、接口、其他应用完全不受影响 |
| `/bfl/` 单独直连 bfl 网关 | 官方前端 pod 自己不代理 `/bfl`（桌面是跨域走 auth 域名 + JWT 拿遥测的），所以壳层直接 `proxy_pass` 到 `bfl` 服务 | 右下角设备状态面板的 `/bfl/monitor/v1alpha1/cluster` 能用同域 cookie 取到数据 |
| 切换 | 改 `edge-desktop` 的 selector | 一条 patch 命令，秒级生效，随时回滚 |
| 工作负载类型 | **裸 Pod**（不是 Deployment） | Olares 的 `appns-validating-webhook` 只校验 deployments/statefulsets/daemonsets 的 CREATE，裸 Pod 不受拦截 |

> 裸 Pod 没有 Deployment 的自愈能力，节点重调度后需要重新 `kubectl apply`。开发期可以接受；
> 真要长期跑，可以把它注册成 Olares 应用（需要走 app 安装流程），那时 webhook 自然会放行。

## 装成 Olares 应用（M6）

```bash
./deploy/install.sh              # 装或升级（幂等）
./deploy/install.sh --lint       # 只校验 chart，不装
./deploy/install.sh --uninstall  # 卸干净，保留数据
```

走的是 `olares-cli market`（应用市场 API），不是 `helm upgrade --install`。两者都能把 pod 跑起来，
差别在**之外**的那些东西：

| | helm 直接装 | 走市场 |
|---|---|---|
| pod 能起来 | ✅ | ✅ |
| Application 记录（桌面图标、卸载入口） | ❌ | ✅ |
| entrance（`https://emergentdesktop.<用户>.olares.com`） | ❌ | ✅ |
| NetworkPolicy（只放行本用户 + 系统网关） | ❌ | ✅ |
| `--uninstall` 是一行 | ❌（要手动删一堆） | ✅ |

`olares-cli chart lint` 是这套东西里唯一能提前拦住错误的地方 —— 它跑的是市场入库同一条流水线：
清单结构、helm dry-run、hostPath 类型、容器资源上限、Chart 与清单版本一致。**每次改 chart 先跑 `--lint`**。

### 安装器给了什么、我们不能再猜什么

装完之后，两个路径由安装器填进 `values`，脚本从 Deployment 的 volumes 里读回来（别自己拼）：

```
userspace.appData → /olares/rootfs/userspace/pvc-userspace-<user>-<随机>/Data/emergentdesktop
userspace.userData → /olares/rootfs/userspace/pvc-userspace-<user>-<随机>/Home
```

`pvc-` 后面那段是随机的，猜错的后果是"跑起来了、数据写进了另一个目录"，而界面上看不出来。

### 为什么代码还是走 hostPath，不进镜像

节点上没有 docker/nerdctl/buildah，也没有可推的镜像仓库 —— 打不了镜像。所以沿用"tar 到 appData，
重启进程生效"这条路。为了让"代码没铺"这件事自己说出来，chart 里加了一个 initContainer
（`busybox`，检查 `/app/agent/server.mjs` 在不在），否则用户看到的是一屏 node 的
`MODULE_NOT_FOUND` 堆栈，那行报错只会说"找不到模块"，不会告诉他该跑什么。

**这也是这一版最大的产品债**：真正可分发要有一个装了代码的镜像。`values.image.agent`
已经是个普通字段，换成真镜像即可，剩下的只是 CI。

### 三个坑（都是实测踩出来的）

1. **同一个版本号只能上传一次**（HTTP 409 `version already exists`）。改代码不用重传 chart ——
   代码在 appData 里，重传的是代码；只有改 chart 才需要升版本号。
2. **状态决定动词**。`market status -a` 会把卸载过的应用留成一行 `uninstalled`，
   照着应用名 grep 就会把"首次安装"当成"升级"，而 upgrade 在 uninstalled 状态下会被后端拒。
   脚本按 STATE 列分派。
3. **桌面壳要 `tier: bfl` 标签**。应用命名空间里的 NetworkPolicy（安装器生成）只放行
   同用户的 user-internal/system 命名空间，以及 `tier=bfl` 的桌面入口；`emergent-shell`
   现在就是桌面入口，不打这个标签它连自己的后端都连不上（实测 499）。

### 卸载与数据

`--uninstall` 只删应用与命名空间，**不动** `Home/Agent` 和 `Data/emergentdesktop`。
记忆不该因为重装而消失 —— 实测卸载再装，16 条记忆、人格设定、drift 记录全在。

### 还没做的隔离

RBAC 还是集群级只读（`ClusterRole`），代码里用命名空间后缀过滤"哪些应用是我的"。
单用户机器上等价；**多用户机器上这是真的会看到别人的 pod**。要做干净，得给每个用户的
命名空间建 Role/RoleBinding（而命名空间是装应用时才出现的，所以绑定也要动态）。

## 首次部署

```bash
# 1. 静态资源（在仓库根目录执行）
#    index.html + src + vendor 是壳层；agent.html 是调试页，别漏（少它就只有 404 可点）
ssh root@HOST 'mkdir -p /olares/emergent-shell/www'
scp -r shell/index.html shell/agent.html shell/src shell/vendor root@HOST:/olares/emergent-shell/www/

# 2. 建 configmap / service / pod
scp deploy/shell-k8s.yaml root@HOST:/root/
ssh root@HOST 'kubectl apply -f /root/shell-k8s.yaml'

# 3. 切到开发版
scp deploy/switch.sh root@HOST:/root/
ssh root@HOST 'bash /root/switch.sh dev'
```

> **`apply` 之后前端不会自己更新。** pod 是 `subPath` 挂 ConfigMap、静态文件走
> hostPath，两边都不会因为你改仓库而变。改完前端必须重新 `scp`/`tar` 一次
> （`/olares/emergent-shell/www`），改完 nginx 必须重建 pod。

## 登录页（auth）

登录入口跟桌面同一套路，但**多一个坑**：官方 `auth-front` 监听 **80**，我们的
`emergent-auth` 监听 **91**（`server_name _` 在 80 上会被镜像自带的
`default.conf`（default_server）抢走，所以不能简单让 pod 也听 80）。
因此切 selector 时必须同时把 `targetPort` 一起改：

```bash
scp -r auth/index.html auth/src auth/vendor root@HOST:/olares/emergent-auth/www/
ssh root@HOST 'bash /root/switch.sh auth dev'       # selector + targetPort 91
ssh root@HOST 'bash /root/switch.sh auth official'  # selector + targetPort 80
```

部署前把 index.html 里的 `__BUILD__` 换成构建戳（缓存排查用）：

```bash
sed "s/__BUILD__/$(date +%Y%m%d%H%M)/g" auth/index.html > /tmp/i.html
scp /tmp/i.html root@HOST:/olares/emergent-auth/www/index.html
```

## 日常迭代

```bash
# 改完代码，同步一个文件
scp shell/src/field.js root@HOST:/olares/emergent-shell/www/src/
# 浏览器刷新即可（nginx 对这个路径发了 no-cache）

本地预览别用 `python -m http.server` —— 它不发 `Cache-Control`，ES Module 会被浏览器
启发式缓存，改完刷新还是旧文件；同源若还有 `scope=/` 的 Service Worker，更是怎么刷
都不变。用 `node auth/serve.mjs 8822`（见下）。
```

## 一键切换

```bash
ssh root@HOST 'bash /root/switch.sh dev'       # 开发壳层
ssh root@HOST 'bash /root/switch.sh official'  # 官方桌面
ssh root@HOST 'bash /root/switch.sh status'    # 当前指向哪个
```

## 第一次切换必须做的一件事：清掉 Service Worker

官方桌面注册了 `scope=/` 的 Service Worker。它还活着的时候，**同源的任何导航都会被它接管**，
你的浏览器会一直拿到旧壳层的缓存，看不到新页面（表现为「切了但没变」）。

任选其一：

- DevTools → Application → Storage → **Clear site data**（勾上 Service Workers / Cache storage），然后硬刷新；
- 或者用无痕窗口（每次都是干净上下文）。

`shell/index.html` 里已经带了一段自动注销 SW 的脚本，但它只在**我们的页面真的被加载**之后才会执行——
第一次被劫持的那一次必须手动清。

## 回滚

```bash
ssh root@HOST 'bash /root/switch.sh official'
# 彻底移除开发壳层：
ssh root@HOST 'kubectl delete pod emergent-shell -n user-space-bbbigdan; kubectl delete -f /root/shell-k8s.yaml'
```

---

# 登录页（emergent-auth）

和壳层同一套路：另起一个 nginx Pod 只接管 `/`，`/api` `/bfl` `/jwks.json` 全部反代回官方的
`auth-front`（`authelia-deployment` 容器），登录协议一行不改。

```bash
# 首次
ssh root@HOST 'kubectl apply -f /root/auth-k8s.yaml'
# 切到我们的登录页
ssh root@HOST 'kubectl patch svc authelia-svc -n user-space-bbbigdan -p "{\"spec\":{\"selector\":{\"app\":\"emergent-auth\"}}}"'
# 回滚
ssh root@HOST 'kubectl patch svc authelia-svc -n user-space-bbbigdan -p "{\"spec\":{\"selector\":{\"app\":\"authelia\"}}}"'
```

静态文件在宿主机 `/olares/emergent-auth/www`，改完 `scp` 上去刷新即生效，不用重启。

## 它长什么样

界面**没有一块 DOM 容器**：`src/ui.js` 用 2D canvas 画一份「墨稿」（用户名、提示、输入框、箭头），
`scan()` 按 cell 网格把覆盖率够的格子采样成点阵，`src/field.js` 用粒子把这些点排出来。
DOM 里只有两样东西：

| 元素 | 作用 |
|---|---|
| `<img id="ava">` | 头像真实照片（官方 CDN 默认图；加载失败退回首字母） |
| `<input id="pw">` | 透明输入框，只为收键盘 / 唤起移动端输入法 |

头像外圈那层流动的粒子是 `field.js` 的 `orbit` 组：不同半径不同角速度形成剪切层，
亮度带沿圆周扫过。它画在头像**上层**，所以看起来是把头像「包」起来的。

## 三个必须照抄的协议细节

1. **密码要先 md5**：`osVersion >= 1.12.0` 时传 `md5(password + "@Olares2025")`，
   常量写在官方包里（`y6(pwd, {osVersion})`）。传明文会被判密码错。
2. **用户名从 `X-Bfl-User` 头取**：Authelia 定制版从 header 拿 ctxuser，
   没有它会回 400 `cannot get user name from header`。正常链路里由网关注入，
   从 pod 内部直连测试时需要手动带。
3. **targetURL**：`?redirect=` / `?rd=` 优先，否则 `https://desktop.<olaresId 的 @ 换成 .>`。

## 点阵的两个硬约束（踩过的坑）

- **笔画宽度必须 ≥ CELL × TH**（现在是 2.2 × 0.40 ≈ 0.88）。低于这个值，同一横截面上
  有的格过阈值有的不过，线就断成虚线。
- **CJK 字要 ~30px 才认得出来**。官方那行提示是 14px，放进点阵里必然糊成一团 ——
  所以这里放大了字号（内容不变，尺寸随媒介）。拉丁字母 16px 就够清晰。

## 粒子 alpha 必须预乘

`gl_FragColor = vec4(rgb, 1.0)` 配 `AdditiveBlending` 在**黑底**上没问题（桌面壳层就是），
但登录页的头像上方会变成一圈**黑色不透明点**——因为 canvas 用预乘 alpha，
`a=1` 意味着「完全不透明，颜色 = rgb」，而 rgb 里已经只剩一点亮度。

正解是 `float a = core * vA; gl_FragColor = vec4(color * a, a);` 配 `NormalBlending`。
换成 `AdditiveBlending` 会把 a 再乘一次（变全黑）；换成 `CustomBlending(One, One)` 也试过，同样不显示。

## agent 服务（`agent-k8s.yaml`）

粒子场的服务端。和壳层同一套思路：裸 Pod + hostPath + Service，不动任何官方资源。

```
kubectl apply -f agent-k8s.yaml          # 首次
```

**三个刻意的选择：**

1. **裸 Pod 而不是 Deployment** —— 和壳层同一个理由（`appns-validating-webhook`
   只校验 deployments/statefulsets/daemonsets 的 CREATE）。代价是没有自愈。
2. **hostPath `/olares/emergent-agent/app`** —— 代码、`.env`、`sessions/` 都在这一棵树里，
   同步一次全到位；改完重启进程就生效，不用 build 镜像。
3. **只读 ClusterRole** —— `pods` / `pods/log` / `deployments` / `services:proxy`。
   不给 secrets、不给 configmaps、不给写。它现在只需要"看"。

**更新代码：**

```bash
# 在仓库根目录
tar czf - --exclude='.kube' --exclude='sessions' --exclude='.env' agent shell \
  | ssh root@199.68.217.186 'tar xzf - -C /olares/emergent-agent/app'
# .env 单独传（key 不进 tar、不进命令行参数）
cat agent/.env | ssh root@199.68.217.186 'cat > /olares/emergent-agent/app/agent/.env && chmod 600 /olares/emergent-agent/app/agent/.env'
# 让 node 重新加载（裸 Pod，删了要自己重建）
kubectl delete pod emergent-agent -n user-space-bbbigdan
kubectl apply -f agent-k8s.yaml
```

**入口只有一个**：`https://desktop.bbbigdan.olares.com`（也就是桌面本身）。
agent 是桌面的一层（`shell/src/deskagent.js`，见 `docs/场界面-设计与接口.md` §11）：

- 鼠标贴到底边 → 粒子下沉、边缝亮起；点击或上拖 → 场从桌面里展开
- 双击桌面空白 → 同样展开
- Esc → 收起，粒子散回球面

`/agent/` **不是入口，是接口的挂载点**：壳层 nginx（`shell-k8s.yaml` 的
`location /agent/`）把整段前缀转给 agent pod，前缀不剥 —— agent 自己认 `/agent/`，
这样它的 `/api/*` 不会和官方 olares-app 抢路径。前端因此必须写**根绝对**路径
`/agent/api/send`：写相对 `api/send` 只在调试页（页面就挂在 `/agent/` 下）成立，
放到桌面根上会被解析成 `/api/send`、被反代回官方 pod 拿到 404，而且不报错 ——
表现为"场展开了，但永远停在 connecting"。

> 注意区分：`bbbigdan.olares.com` 是 Olares 门户，`desktop.bbbigdan.olares.com`
> 才是被 `edge-desktop` 这个 Service 接管的那台桌面。改完前端要 `scp` 到
> `/olares/emergent-shell/www`（壳层）**和** `/olares/emergent-agent/app/shell`
> （agent pod 自己的 `WEB_ROOT`，调试页/隧道用它）两处，否则你会在两个地址上
> 看到两个不同版本的界面。

`agent.html` 还留着，但它只是"把场单独拿出来看"的调试页（`/agent/agent.html`）。
`?dev=1` 才显示观察窗/连接状态；`?apps=demo` 不带登录态也能把桌面立起来（调 UI 用）；
`?debug=1` 把 `window.__em` 挂出去，给 CDP 量粒子状态。

**踩过的坑：**

- `.kube` 必须排除在 tar 之外。那里面是集群客户端私钥，等于 root shell。
- nginx 的 `location /agent/` 需要 `proxy_buffering off`，否则 SSE 会被攒着一起发。
- ConfigMap 是 subPath 挂载，改完**必须重建 Pod**：`kubectl exec nginx -s reload` 没用，
  容器里那份文件根本不会更新。
- `WEB_ROOT` 要指到 `/app/shell`（装页面的那层）。指错了页面能开但 `./src/*.js` 全 404。

## 记忆侧车（axolotl）

agent pod 现在是**两个容器**：`agent`（Node）+ `memory`（Python 3.11 + axolotl）。

```
浏览器 → /agent/api/*  →  agent:8788  ──127.0.0.1:7801──▶  memory:7801 (memsvc)
                                                              └─ .axeb（~/Agent/memory）
```

| 项 | 值 |
|---|---|
| 镜像 | `python:3.11-slim`（**别升 3.12**，wheel 是 cp311） |
| 代码 | `/app/agent/memsvc/server.py`（跟着 tar 一起同步） |
| 图库 | `/olares/emergent-py`（hostPath）里的 `axolotl_rs`，靠 `PYTHONPATH=/py` 加载 |
| 数据 | `~/Agent/memory/memory.axeb` + `snapshots/`；旧的 `memory.db` 首次启动迁入后改名 `.migrated` |
| agent 侧 | `MEMORY_STORE=axolotl` `MEMORY_URL=http://127.0.0.1:7801` |

**为什么不打自建镜像**：wheel 是构建产物，放在 hostPath 里就能用；改 `server.py`
只需 tar 一次 + 重建 pod，不用装 Docker、不用推仓库。这跟壳层的思路一致。

### 重建 wheel（改了 Rust 绑定才需要）

axolotl 的 Python 绑定补过一处：原版只能"知道 id 才能查"，补了 `vertices()` / `edges()`
两个全量枚举（补丁见 `deploy/axolotl-py-bindings.patch`），否则上层得自己维护一份
会和图漂移的 id 目录。

```bash
# 1. 源码（已打过 deploy/axolotl-linux.patch + axolotl-py-bindings.patch）在
#    宿主机 /olares/emergent-build/prototype-rust
# 2. 用构建 pod（rust:1-bookworm）编：
kubectl apply -f /root/axbuild.yaml
kubectl exec -n user-space-bbbigdan axbuild -- bash -c '
  export PATH=/usr/local/cargo/bin:$PATH
  which maturin || (apt-get update -qq && apt-get install -y -qq python3 python3-dev python3-pip &&
                    pip3 install --break-system-packages -q maturin)
  cd /src/prototype-rust && cargo build --release --features python-bindings &&
  maturin build --release --features python-bindings --out /src/dist'
# 3. 装进 hostPath（pip --target，不污染系统 Python）：
cp /olares/emergent-build/dist/axolotl_rs-*.whl /olares/emergent-py/
kubectl run pyinst -n user-space-bbbigdan --image=python:3.11-slim --restart=Never \
  --overrides='{"spec":{"volumes":[{"name":"py","hostPath":{"path":"/olares/emergent-py"}}],
  "containers":[{"name":"pyinst","image":"python:3.11-slim",
  "command":["pip","install","--no-index","--target","/py","/py/axolotl_rs-0.1.0-cp311-cp311-manylinux_2_34_x86_64.whl"],
  "volumeMounts":[{"name":"py","mountPath":"/py"}]}]}}'
```

有缓存时 `cargo build` 约 30s，冷编译约 2 分钟。

### 日常更新

```bash
# 只改了 server.py / agent 代码：tar + 重建 pod（两个容器一起重启，图会先落盘）
tar czf - --exclude=agent/.env --exclude=agent/sessions agent |
  ssh root@HOST 'tar xzf - -C /olares/emergent-agent/app'
ssh root@HOST 'kubectl delete pod emergent-agent -n user-space-bbbigdan --wait && \
               kubectl apply -f /root/agent-k8s.yaml'
```

**排障**

```bash
kubectl logs -n user-space-bbbigdan emergent-agent -c memory   # 侧车：开了哪个图、节点数
kubectl logs -n user-space-bbbigdan emergent-agent -c agent    # [memory] axolotl · … · N 条记忆
curl localhost:9788/agent/api/memory?q=n8n                     # 端口转发后：stats + 一次回忆
curl localhost:9788/agent/api/memory?sweep=1                    # 立刻巩固一次
kubectl exec -n user-space-bbbigdan emergent-agent -c memory -- ls -l /userspace/*/Home/Agent/memory
```

- **两个容器是并行起的**，agent 会等侧车最多 8 秒（实测差 1~2 秒）。等不到就停用记忆，
  桌面照常 —— 但**不会**退回 SQLite（两份库同时活着等于记忆分叉）。
- 侧车每 2.5 秒空闲落盘一次（`save_to` 临时文件 + rename），SIGTERM 时同步落盘再退。

## 自造工具（M4）

自造工具全部落在**用户空间**里，和 Files 应用看到的是同一批文件：

```
~/Agent/tools/<name>/manifest.json    名字 / 参数 / needs / 版本 / draft|published
~/Agent/tools/<name>/run.mjs|run.cjs  脚本
~/Agent/tools/<name>/history/         旧版本
~/Agent/skills/<slug>.md              "以后就这么办"
~/Agent/audit/tools-<day>.jsonl       每次调用一行
```

不需要挂新卷、不需要打新镜像 —— `userspace` 那个 hostPath 已经在 pod 里了。
排查：

```bash
kubectl exec -n user-space-bbbigdan emergent-agent -c agent -- \
  sh -c 'ls -la /userspace/pvc-userspace-*/Home/Agent/tools/'
kubectl exec -n user-space-bbbigdan emergent-agent -c agent -- \
  sh -c 'tail -5 /userspace/pvc-userspace-*/Home/Agent/audit/tools-*.jsonl'
# 单元自测（不需要模型，Pod 里也能跑：验证 Linux 上的路径守卫）
kubectl exec -n user-space-bbbigdan emergent-agent -c agent -- sh -c 'cd /app && node agent/tools/forge.test.mjs'
```
