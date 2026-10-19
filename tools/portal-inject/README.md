# Olares 粒子门 · 注入调试工程

不打包镜像、不改官方仓库，用 Tampermonkey 把粒子层「外挂」到运行中的 Olares 桌面上调试。
改一行代码 → 1 秒内页面自动热替换，比「改代码 → 构建镜像 → 升级实例 → 刷新」快两个数量级。

```
┌──────────────┐   GM_xmlhttpRequest /bundle.js    ┌────────────────────┐
│ Tampermonkey │ ────────────────────────────────▶ │  serve.mjs :8790   │
│  (浏览器)     │ ◀──── 轮询 /version（1s）───────── │  three+inject 打包  │
└──────┬───────┘                                   └─────────┬──────────┘
       │ new Function(code)()                                │ fs.watch
       ▼                                                     ▼
  页面里出现 canvas + 粒子环                          src/inject.js 一改就重建
```

---

## 一、三步跑起来

```bash
cd tools/portal-inject
node serve.mjs                    # 起本地打包/热更服务（8790）
# 另开一个窗口验证：http://127.0.0.1:8790/   ← 本地 mock 桌面页，结构同 BasicWindow.vue
```

1. 浏览器装 Tampermonkey，新建脚本，把 `olares-portal.user.js` 整个粘进去保存。
2. 打开你的 Olares 桌面（`https://<你的域名>/`），等桌面加载完。
3. 看到粒子小点绕圈 → 成功。点开任意应用，窗口会从粒子环里长出来。

改 `src/inject.js` 保存，约 1 秒后页面自动 dispose 旧层、注入新层。**不用刷新页面。**

---

## 二、为什么是外挂，而不是改源码

Olares 的前端是 `apps/packages/app`（Vue 3 + Quasar + lerna），要跑起来需要
`npm install` + 后端 API + 登录态 + 反向代理；而粒子层本身是**纯 Three.js + DOM，与框架零耦合**。
所以先用外挂把视觉和交互调到位，再一次性并进仓库，返工成本最低。

三种调试方式的分工（不是互斥，按阶段选）：

| 方式 | 适合什么 | 代价 | 什么时候用 |
| --- | --- | --- | --- |
| **Tampermonkey 外挂**（本项目） | 加一层：粒子门、调试面板、性能 HUD、A/B 参数 | 拿不到 Vue 组件状态；跨域 iframe 内不可达 | **现在**：调效果、验证时序、试参数 |
| **Chrome Local Overrides** | 改官方已有文件：`BasicWindow.vue` 编译产物、CSS、路由 | 只能改已存在的文件，不能新增；压缩代码难读 | 需要改窗口本体（标题栏、拖拽、开关窗动画）时 |
| **本地 dev server**（`npm run dev` + 反代实例） | 真开发：源码断点、Vue Devtools、HMR | 一次性搭环境成本高（依赖、鉴权、证书） | 功能定了、开始做代码合并时 |

判断标准很简单：**改的是「外面加的一层」→ 外挂；改的是「里面已有的一行」→ Overrides / dev server。**

---

## 三、目录

```
tools/portal-inject/
├── src/inject.js              注入层：找窗口 → 读矩形 → 粒子环 → 揭示/散开（唯一要改的文件）
├── serve.mjs                  本地服务：动态打包 + /version 热更 + mock 页
├── olares-portal.user.js      Tampermonkey 引导脚本（拉包、热替换、开关）
├── mock/desktop.html          离线 mock：结构对齐 .desktop-box / .iframe-box / .iframe-window
└── README.md
```

打包方式与 `prototype/build-standalone.mjs` 一致：把 `three.module.min.js` 的
`export{…}` 改写成 `const THREE = {…}`，再和 `inject.js` 一起包进 IIFE
（主代码套一层 `{}` 块，避免与 three 压缩后的顶层短名冲突）。

---

## 四、注入层怎么定位窗口

Olares 桌面 DOM（已核实源码）：

```html
<div class="desktop-box">
  <div class="iframe-box" style="z-index:10">     <!-- VueDragResize：可拖动/缩放 -->
    <div class="title">…</div>
    <iframe class="iframe-window" src="https://files.…">
  </div>
</div>
```

- 用 `MutationObserver` 监听 `.iframe-box` 出现，**新窗口自动接管**（打开另一个应用 → 重新从点长出来）。
- 每帧 `getBoundingClientRect()`，窗口被拖动/缩放时粒子环实时跟随（不需要监听拖拽事件）。
- 揭示只改 `opacity`，**绝不动 `transform`**：那会和 `VueDragResize` 的位移打架。
- 边缘用 `mask-image` 做软过渡（横向 60px / 纵向 44px），四角自然更虚。

---

## 五、调试接口

浏览器控制台：

```js
__OP__.stats()      // { n, fps, t, pe, rev, err, bound, rect }
__OP__.probe(5)     // 粒子采样 + 渲染统计（calls/pts/worst/far/nan/geom）
__OP__.replay()     // 从头再来一遍
__OP__.scatter()    // 粒子四散
__OP__.dispose()    // 拆掉（恢复窗口 opacity/mask，删 canvas）
__OP__.config       // 运行时参数（N / SEED / GROW / REVEAL_A …）
__OP_OFF__() / __OP_ON__()   // 彻底关掉/打开（Tampermonkey 侧）
```

深链（mock 页与线上都可用，线上加在桌面 URL 后面）：

| 参数 | 作用 |
| --- | --- |
| `?op-at=1.6&op-freeze=1` | 预热到 1.6s 并定格，无头截图可复现任意时刻 |
| `?op-n=4000` | 粒子数（默认 6000，范围 1200–12000） |

---

## 六、已知限制（都是外挂方式自带的，不是 bug）

1. **CSP**：Olares 页面若开 `script-src` 限制，页面体内的 `<script>` 会被拦；本方案走
   `GM_xmlhttpRequest` + `new Function` 在 userscript 沙箱里执行，绕开页面 CSP，但要求 Tampermonkey 有 `unsafe-eval`。
2. **跨域 iframe 不可达**：粒子只能盖到窗口边界，进不到应用内部（这也是生产形态的约束，不是调试期的妥协）。
3. **Vue 重渲染**：窗口重建时 inline `style.opacity` 会丢，`MutationObserver` 会重新 bind 并重播时间轴——目前正好是想要的效果；
   若以后不希望重播，改成「已展示窗口直接 rev=1」。
4. **HTTPS 页面拉 localhost**：普通 `fetch` 会被混合内容拦，所以走 `GM_xmlhttpRequest`（扩展上下文不受限）。
5. **性能**：注入层与页面共享一个 GPU 进程；粒子 6000 时软渲染环境约 40fps，真机无压力。
   逐帧改 `opacity` 已做变化阈值，避免逼 GPU 反复合成 iframe。

---

## 七、什么时候结束外挂阶段

满足这三条就切到源码合并：

- 时序不再改（`SEED/GROW/REVEAL_A` 连续两天没动过）；
- 视觉参数收敛（亮度/密度/雾化宽度不再逐帧调）；
- 需要动窗口本体了（标题栏融合、开关窗联动路由、多窗口同时展开）。

到那时把 `src/inject.js` 的「窗口绑定 + 粒子环」两块逻辑搬成 Vue 组件
（`ParticlePortal.vue`），时间轴抽成 composable，其余照旧——外挂期验证过的参数可以直接当默认值。
