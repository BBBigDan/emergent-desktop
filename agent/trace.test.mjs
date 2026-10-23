/**
 * 「思考过程」的措辞自测：`node agent/trace.test.mjs`
 *
 * 它钉住两件事：
 *   ① **每个工具都有一个人话动词**。少一个不会报错 —— 屏幕上那行会直接
 *      变成 `fs_list`，而这看起来像"界面上漏了文案"，查起来要翻三层。
 *   ② 宾语从参数里取对了。取错的表现同样安静：屏幕上写"读文件 a.txt"
 *      而它实际读的是 b.txt。
 */

import { toolLine } from './trace.mjs';
import { makeTools } from './tools.mjs';

let failed = 0;
const ok = (c, l, e = '') => { if (c) console.log('  ✓ ' + l); else { failed++; console.log('  ✗ ' + l + (e ? ` — ${e}` : '')); } };

console.log('每个工具都有一句人话');
{
  const tools = makeTools({ source: 'host' });
  const names = tools.schemas().map((s) => s.function.name);
  ok(names.length > 20, `工具有 ${names.length} 个`);
  const missing = names.filter((n) => {
    const r = toolLine(n, {});
    return !r.verb || r.verb === n;
  });
  ok(missing.length === 0, `没有漏译的（漏了：${missing.join(', ') || '无'}）`);
  /* 动词不能长到把那一行撑爆：12px × 12 字 ≈ 144px，面板一行放得下 */
  const long = names.map((n) => toolLine(n, {})).filter((r) => Array.from(r.verb).length > 9);
  ok(long.length === 0, `动词都 ≤9 字${long.length ? `（超了：${long.map((r) => r.verb).join(',')}）` : ''}`);
}

console.log('宾语从参数里取');
{
  ok(toolLine('fs_read', { path: '/home/bbbigdan/Downloads/电影.mkv' }).detail === '电影.mkv',
    'fs_read → 文件名');
  ok(toolLine('fs_read', { path: '/home/bbbigdan/x/y' }).detail === 'y', '取最后一段，不是整条路径');
  ok(toolLine('logs_tail', { app: 'n8n', lines: 70 }).detail === 'n8n 70 行', 'logs_tail → 应用 + 行数');
  ok(toolLine('olares', { op: 'apps' }).detail === '应用清单', 'olares.apps → 应用清单');
  ok(toolLine('olares', { op: 'pods' }).detail === 'pod 列表', 'olares.pods → pod 列表');
  ok(toolLine('olares_act', { act: 'stop', name: 'navidrome' }).detail === '停掉 navidrome',
    'olares_act → 动词 + 名字');
  ok(toolLine('olares_act', { act: 'uninstall', name: 'n8n' }).verb.includes('系统'), '写操作有单独的动词');
  ok(toolLine('web_get', { url: 'https://api.github.com/repos/a/b' }).detail === 'api.github.com',
    'web_get → 域名而不是整条 URL');
  ok(toolLine('k8s_get', { kind: 'pod', name: 'n8n-0' }).detail === 'pod n8n-0', 'k8s_get → kind + name');
}

console.log('参数缺失/畸形也不许抛');
{
  for (const n of ['fs_read', 'olares', 'olares_act', 'web_get', 'logs_tail', 'draw']) {
    let threw = false;
    try { toolLine(n, undefined); toolLine(n, {}); toolLine(n, { url: '不是 url' }); } catch { threw = true; }
    ok(!threw, `${n} 不抛`);
  }
  ok(toolLine('不存在的工具', {}).verb === '不存在的工具', '未知工具退回原名（不是空字符串）');
  ok(Array.from(toolLine('fs_search', { q: '这是一个特别特别特别长的搜索词' }).detail).length <= 24,
    '宾语封顶 24 字（超了会顶掉右边的耗时）');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
