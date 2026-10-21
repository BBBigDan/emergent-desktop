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

## 首次部署

```bash
# 1. 静态资源（在仓库根目录执行）
ssh root@HOST 'mkdir -p /olares/emergent-shell/www'
scp -r shell/index.html shell/src shell/vendor root@HOST:/olares/emergent-shell/www/

# 2. 建 configmap / service / pod
scp deploy/shell-k8s.yaml root@HOST:/root/
ssh root@HOST 'kubectl apply -f /root/shell-k8s.yaml'

# 3. 切到开发版
scp deploy/switch.sh root@HOST:/root/
ssh root@HOST 'bash /root/switch.sh dev'
```

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

**入口**：`https://<域名>/agent/`，由壳层的 nginx 转过去（`shell-k8s.yaml` 里的
`location /agent/`）。前缀不剥 —— agent 自己认 `/agent/`，这样它的接口不会和
官方 olares-app 的 `/api/*` 抢路径。

**踩过的坑：**

- `.kube` 必须排除在 tar 之外。那里面是集群客户端私钥，等于 root shell。
- nginx 的 `location /agent/` 需要 `proxy_buffering off`，否则 SSE 会被攒着一起发。
- ConfigMap 是 subPath 挂载，改完**必须重建 Pod**：`kubectl exec nginx -s reload` 没用，
  容器里那份文件根本不会更新。
- `WEB_ROOT` 要指到 `/app/shell`（装页面的那层）。指错了页面能开但 `./src/*.js` 全 404。
