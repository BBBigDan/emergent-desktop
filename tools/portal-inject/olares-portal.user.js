// ==UserScript==
// @name         Olares 粒子门 · 注入调试（热更新）
// @namespace    olares.portal.dev
// @version      0.1.0
// @description  从本机 8790 端口加载粒子门注入包，改代码后 1 秒内热替换，不用重打包镜像
// @match        https://*/*
// @match        http://127.0.0.1:8790/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window) return;             // 只在顶层桌面文档里跑
  const BASE = 'http://127.0.0.1:8790';
  let version = null;
  let booted = false;

  const gmGet = (path) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: BASE + path,
      timeout: 4000,
      onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
      onerror: reject,
      ontimeout: reject,
    });
  });

  async function load() {
    const code = await gmGet('/bundle.js?ts=' + Date.now());
    // new Function 在 userscript 沙箱里执行，不受页面 CSP 的 script-src 限制
    new Function(code)();
    booted = true;
    console.log('[粒子门] 注入完成 ' + (version || ''));
  }

  async function tick() {
    try {
      const v = JSON.parse(await gmGet('/version')).version;
      if (version === null) {
        version = v;
        // 等桌面根节点出现再注入（登录页、错误页不打扰）
        if (document.querySelector('.desktop-box') || document.querySelector('.iframe-box')) await load();
        else waitDesktop();
        return;
      }
      if (v !== version) {
        version = v;
        if (window.__OP__) window.__OP__.dispose();
        if (booted) await load();
      }
    } catch (e) {
      /* 服务没起来就静默重试 */
    }
  }

  function waitDesktop() {
    const mo = new MutationObserver(() => {
      if (document.querySelector('.desktop-box') || document.querySelector('.iframe-box')) {
        mo.disconnect();
        load().catch(() => {});
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  setInterval(tick, 1000);
  tick();

  // 手动开关：控制台里 __OP_OFF__() / __OP_ON__()
  window.__OP_OFF__ = () => { if (window.__OP__) window.__OP__.dispose(); booted = false; };
  window.__OP_ON__ = () => load().catch((e) => console.warn('[粒子门] 加载失败', e));
})();
