# 涌现式桌面 · 部署与回滚

把官方的 `/` 换成一片粒子场，并且保留**一条命令切回去**的能力。

**定位**：这是社区版桌面的**替换层**，不是市场里的一个应用。换桌面这件事本来就不该
做成"点两下"——它要么由装机的人做，要么让用户自己敲一条命令。所以这里不追求
entrance、不追求市场卸载入口，只追求三件事：**一条命令装、一条命令回滚、挂了会自己回来**。

## 为什么不是「改官方 deployment」

直接改 `olares-app-deployment`，或者往它的 `/www` 里塞文件，都不合适：`/www` 是
**emptyDir**，init 容器每次启动都会重新拷贝，pod 一重启我们的文件就没了；而直接换镜像
会把 Files / Market / Settings 这些同 pod 的应用一起带走。

所以这里另起一个工作负载，只接管「桌面入口」这一个端口，其余请求全部反代回官方 pod。

```
浏览器
  │  https://desktop.<user>.olares.com
  ▼
envoy ──► Service edge-desktop (80 → 91)
             │  selector 决定去哪个 pod
             ├── app=emergent-desktop →  我们的 pod（nginx + agent + memory）  替换版
             └── app=olares-app       →  官方前端 pod                          官方版
```

三件事挤在同一个 pod 里，是故意的：nginx 用 `127.0.0.1:8788` 调 agent，
不跨命名空间、不走 Service、不需要任何 NetworkPolicy 白名单。

## 为什么工作负载是 ReplicaSet

Olares 的 `appns-validating-webhook` 只拦 `deployments` / `statefulsets` / `daemonsets`
的 **CREATE**（规则里就这三个 resource，verbs 只有 CREATE）。

- **裸 Pod** 能过，但不自愈：节点重启、手滑 delete 之后桌面就死在那儿，
  而"桌面不见了"没有任何地方会报错。
- **ReplicaSet** 能过，而且删 pod 10 秒自己回来（实测：删掉后新 pod 三容器全 Ready，
  桌面入口仍然 200）。

> ⚠️ **ReplicaSet 不会滚动更新。** 改 pod template 之后它只保证"数量对"，**不会替换已有 pod**。
> 所以 `install.sh` 在 apply 之后会显式删一次 pod —— 否则你改了模板、看到的还是旧容器的日志，
> 那种"我明明改了"的错觉最费时间。

## 装 / 回滚 / 卸载

```bash
./deploy/install.sh              # 装或更新：铺代码 → 建工作负载 → 接管桌面入口
./deploy/install.sh --revert     # 桌面切回官方，我们的 pod 留着
./deploy/install.sh --uninstall  # 切回官方 + 删工作负载与权限（数据保留）
```

脚本做五件事，顺序是有原因的：

1. 找用户 Home（`pvc-userspace-<user>-<随机>`，**不能猜**）；
2. 铺静态文件到 `/olares/emergent-desktop/www`、agent 到 `.../app`；
3. 写 `emergent-desktop-env` Secret（模型 key，不写进 yaml）；
4. apply 清单 → 删 pod → 等三容器 Ready；
5. **最后**才改 `edge-desktop` 的 selector。反过来做的表现是"桌面白屏十几秒"，
   而用户只会以为它坏了。

## 数据在哪

| | 路径 | 说明 |
|---|---|---|
| 静态 | `/olares/emergent-desktop/www` | 改完重传即生效（nginx 发 no-cache） |
| 代码 | `/olares/emergent-desktop/app` | 代码是卷不是镜像，**重启才生效** |
| 记忆/人格 | `Userspace/Home/Agent` | Files 里看得见；卸载不删 |

代码不进镜像，是这条路的既定代价：节点上确实没有 docker/nerdctl/buildah，
也没有可推的仓库。清单里有个 `check-code` initContainer，代码没铺时会直接说
"跑一次 deploy/install.sh"，而不是甩一屏 `MODULE_NOT_FOUND`。

## 四个坑（都踩过）

1. **别给这个 pod 打 `tier: bfl`。** 之前为了过应用命名空间的 NetworkPolicy 打过一次，
   结果 `bfl` 这个 Service 的 selector 就是 `tier: bfl` —— 壳层立刻被塞进它的 endpoints，
   一半请求打到不监听 8080 的 nginx 上，市场 API 直接 400 `connection refused`。
   **别蹭平台的标签。**
2. **改 nginx 配置要重建 pod。** ConfigMap 是 `subPath` 挂进去的，改了不会自动同步。
3. **第一次切换必须清 Service Worker。** 官方桌面注册了 `scope=/` 的 SW，它还活着时
   同源导航都会被它接管，表现是"切了但没变"。DevTools → Storage → Clear site data，
   或者用无痕窗口。`shell/index.html` 里有自动注销脚本，但只在我们的页面真的被加载后才执行。
4. **两套并存会写坏记忆库。** `memory.axeb` 只能有一个进程写。换安装方式之前，
   先把旧的那套停掉（`--uninstall` 或删旧工作负载）。

## 回滚

```bash
./deploy/install.sh --revert              # 桌面回官方，pod 留着
./deploy/install.sh --uninstall           # 连工作负载一起删（数据保留）
ssh root@HOST 'bash deploy/switch.sh status'   # 现在指向谁
```

`switch.sh` 还能切登录页（`auth dev` / `auth official`），那段没变，见下。

---

# 登录页（emergent-auth）

登录入口跟桌面同一套路，但**多一个坑**：官方 `auth-front` 监听 **80**，我们的
`emergent-auth` 监听 **91**（`server_name _` 在 80 上会被镜像自带的 `default.conf`
（default_server）抢走，所以不能简单让 pod 也听 80）。
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

## 关键设计

| 点 | 做法 | 原因 |
|---|---|---|
| 静态文件 | hostPath `/olares/emergent-desktop/www` | 改完 `tar` 即生效，不用打镜像 |
| 只接管 `/` | nginx `try_files`，`/api` `/server` `/kapis` … 反代到 `olares-app-official:91` | 登录态、接口、其他应用完全不受影响 |
| `/bfl/` 单独直连 bfl 网关 | 官方前端 pod 自己不代理 `/bfl`（桌面是跨域走 auth 域名 + JWT 拿遥测的），所以壳层直接 `proxy_pass` 到 `bfl` 服务 | 右下角设备状态面板的 `/bfl/monitor/v1alpha1/cluster` 能用同域 cookie 取到数据 |
| 切换 | 改 `edge-desktop` 的 selector | 一条 patch，秒级生效，随时回滚 |
| agent | 同一个 pod 的 `127.0.0.1:8788` | 不跨命名空间、不过 netpol、不占 Service |

## 日常迭代

```bash
# 改前端：重传 www，浏览器刷新即可
./deploy/install.sh          # 全量同步 + 重建 pod
# 只改一个文件时可以直接 scp：
scp shell/src/field.js root@HOST:/olares/emergent-desktop/www/src/
```

本地预览别用 `python -m http.server` —— 它不发 `Cache-Control`，ES Module 会被浏览器
启发式缓存，改完刷新还是旧文件。用 `node auth/serve.mjs 8822`。

---

# 附录：曾经把它做成市场应用，为什么撤了

2026-10-21 当天先做了一版 Olares 应用包（`olares-cli chart lint` → 上传本地源 →
`market install`），能装能卸、数据在 Home、pod 自愈，这些都验过。**然后撤了**，原因是定位：

1. **应用装不出"换桌面"。** `edge-desktop` 在 `user-space-<user>` 里，应用 pod 在
   `<appid>-<user>` 里，而 **Service 的 selector 只在同一命名空间内生效** ——
   桌面入口永远选不到应用里的 pod。这是 Kubernetes 的约束，不是 Olares 的。
2. **1.12.7 没有"桌面应用"这个概念。** `Application` CRD 里没有任何 desktop/theme 字段，
   机器上装的应用 `olaresManifest.type` 全是 `app`。
3. **官方桌面不只是静态页。** 它还要代理 `/api`、`/bfl`、`/kapis`。顶替它必须有个 pod 在
   user-space 里同时干"服务壳层 + 反代官方接口"，那个 pod 注定不属于应用的生命周期。
4. **两套生命周期错配是真事故。** 卸应用之后桌面还停在被替换的状态：粒子场照动，
   `/agent/` 502 —— 用户在市场点"卸载"，得到的是"东西半没了"。

结论：换桌面是**平台级替换**，就该用一个平台级替换的东西去做。市场应用那套的收益
（卸载入口、图标、隔离）对"社区版桌面"这个定位不值那个复杂度。

如果哪天要做成市场应用，那份 chart 在 git 历史里（提交 `32ecb8c`），坑也记在那儿：
同版本 409、`status -a` 残留 uninstalled 行、`userspace.appData` 不能 `required`。
