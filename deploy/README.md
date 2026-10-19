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

## 日常迭代

```bash
# 改完代码，同步一个文件
scp shell/src/field.js root@HOST:/olares/emergent-shell/www/src/
# 浏览器刷新即可（nginx 对这个路径发了 no-cache）
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
