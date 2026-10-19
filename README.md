# 涌现式桌面 · Emergent Desktop

> 窗口不是被「打开」的，而是从一粒光里长出来的。

一个把桌面视觉层从「静态布局 + 硬边窗口」换成「连续粒子场」的实验项目：界面从场里凝出、
交互结束再散回场里。目标是给 [Olares](https://github.com/beclab/Olares) 社区版做一套
涌现式的桌面外壳（shell），而不是又一套图标网格。

**当前状态：技术原型已冻结（`prototype-v1` / v0.17），正在往下游落地。**

---

## 为什么做这个

图形界面四十年来都在回答同一个问题：**东西该摆在哪儿**。图标、Dock、窗口边框、阴影——
都是为了让「一块矩形」看起来像有实体的东西。代价是桌面永远是一张静止的图。

这个项目想验证另一条路：**桌面是一团一直在动的场**。

- 静止时它是球体 / 环面 / 星系，像活物一样呼吸，颜色随负载与温度变化；
- 唤出时粒子收拢、重排，把文字和控件「点」出来——每个字都是真实的粒子，不是贴图；
- 打开窗口时，粒子从小点开始绕圈流动，缓慢撑成窗口的形状，内容像从雾里析出；
- 关闭时粒子四散，窗口退回雾中。

关键不是特效，而是**边界消失了**：窗口没有一条硬边，它是被一圈流动的光围出来的。

---

## 已经验证了什么

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 粒子体（形态 / 呼吸 / 形变 / 配色） | ✅ | 5 种形态 + 引力形变 + 全局呼吸脉冲；颜色=温度，负载=运动速度 |
| 粒子 UI（点阵字体） | ✅ | 离屏采样 → 覆盖率阈值 → 1:1 格心点阵，文字 1:1 锐利；悬停时增援粒子倾泻 |
| 粒子门（iframe 从粒子里长出来） | ✅ | 小点先流动 → 缓慢扩环 → 内部够大才渐现内容 → 散开炸裂 |
| 梦境边缘（半透明 + 毛玻璃 + 渐变） | ✅ | 四边/四角 mask 衰减 + 单层 `backdrop-filter` + 全屏雾随浮现退去 |
| 外挂注入调试链路 | ✅ | Tampermonkey 从本地服务拉包，改代码 1 秒热替换，不用重打镜像 |
| 接入 Olares 官方栈 | ⬜ | 目标：Vue 3 + Quasar 的窗口层，详见 [`docs/原型移交说明.md`](docs/原型移交说明.md) |

验收数值（骨架收敛偏差 1.1px、槽位 3462 vs 骨架 3500、点距/光斑 1.42、零 console 报错）
和逐版被推翻的方案都记在文档里，不在这里堆。

---

## 目录结构

```
emergent-desktop/
├── prototype/                  技术原型（Three.js，无框架、无构建依赖）
│   ├── index.html              粒子群 + 粒子 UI
│   ├── portal.html             粒子门：iframe 从粒子里长出来（v0.17）
│   ├── demo-dashboard.html     被包裹的示例页面（仿 Olares 控制台）
│   ├── src/main.js             粒子体 / 粒子 UI 全部逻辑（约 2000 行）
│   ├── src/portal.js           粒子门：圆角矩形周长参数化 + 环流物理 + 边缘雾化
│   ├── vendor/                 Three.js 本地副本（离线可用，未走 CDN）
│   ├── build-standalone.mjs    内联打包成单文件 HTML
│   └── README.md               ※ 原型完整技术说明在这里
├── tools/portal-inject/        外挂注入调试工程（Tampermonkey + 本地热更服务）
├── docs/                       需求评估、原型移交说明
└── LICENSE                     MIT
```

---

## 快速开始

原型不需要任何依赖管理，起一个静态服务器就能跑（ES Module + importmap 必须走 http，
`file://` 打不开）：

```bash
git clone https://github.com/<your-name>/emergent-desktop.git
cd emergent-desktop/prototype
python -m http.server 8765
# → http://localhost:8765/index.html     粒子群 + 粒子 UI
# → http://localhost:8765/portal.html    粒子门（粒子包裹 iframe）
```

想要双击即开的单文件版：

```bash
cd prototype
node build-standalone.mjs     # → particle-sphere-standalone.html（已 gitignore）
```

### 在真实的 Olares 桌面上试

不改进官方镜像，用外挂方式把粒子层注入到运行中的桌面：

```bash
cd tools/portal-inject
node serve.mjs                # → http://127.0.0.1:8790/  本地 mock 桌面页
```

浏览器装 Tampermonkey，新建脚本粘贴 `tools/portal-inject/olares-portal.user.js`，
然后打开你的 Olares 桌面。改 `tools/portal-inject/src/inject.js` 保存，约 1 秒后
页面自动换掉旧粒子层——不用刷新、不用重新打包镜像。

---

## 路线图

- [x] 粒子体原型（形态 / 呼吸 / 形变 / 配色）
- [x] 粒子 UI：点阵字体工程（v0.14）
- [x] 粒子门：窗口从粒子里长出来（v0.15 → v0.17）
- [x] 梦境边缘：半透明 + 毛玻璃 + 从雾里析出
- [x] 外挂注入调试链路（免打包镜像）
- [ ] 接入 Olares 官方栈（Vue 3 + Quasar 窗口层）——当前进行中
- [ ] 窗口语义扩展：切换 / 最小化 / 多窗口的粒子行为
- [ ] 性能预算：低端 GPU 与软渲染下的降级策略
- [ ] 社区版镜像与一键安装

---

## 文档

- [`prototype/README.md`](prototype/README.md) —— 原型完整技术说明：物理、参数表、深链、验证方法
- [`prototype/CHANGELOG.md`](prototype/CHANGELOG.md) —— 逐版变更，含「为什么这么改」与被推翻的方案
- [`docs/原型移交说明.md`](docs/原型移交说明.md) —— 验收基线、代码复用度、接入官方仓库的改造点、风险清单
- [`docs/Olares涌现式UI需求文档-评估报告.md`](docs/Olares涌现式UI需求文档-评估报告.md) —— 需求评估

---

## 协议与上游说明

本项目自身代码以 **MIT** 发布，见 [LICENSE](LICENSE)。

需要留意：上游 [Olares](https://github.com/beclab/Olares) 采用 **AGPL-3.0**
并附带额外的 `LICENSE.md`（限制商用）。本仓库目前**不包含任何上游代码**，
只通过外挂注入方式与运行中的 Olares 协作；一旦将来把上游代码并入本仓库，
相关目录的协议会随之调整并在该目录内单独声明。

「Olares」是其所有者的商标，本项目为社区独立实验，非官方项目。
