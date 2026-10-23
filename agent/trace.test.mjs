/**
 * 「思考过程」的措辞自测：`node agent/trace.test.mjs`
 *
 * 它钉住两件事：
 *   ① **每个工具都有一个人话动词**。少一个不会报错 —— 屏幕上那行会直接
 *      变成 `fs_list`，而这看起来像"界面上漏了文案"，查起来要翻三层。
 *   ② 宾语从参数里取对了。取错的表现同样安静：屏幕上写"读文件 a.txt"
 *      而它实际读的是 b.txt。
 */

import { toolLine, reasonLines, alike } from './trace.mjs';
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

/* ───────────────── 它的思考：一段自由文本 → 能上屏的短句 ───────────────── */

console.log('\n思考：中文照句切');
{
  const L = reasonLines('用户问内存够不够用。需要先调用工具看机器状态。');
  ok(L.length === 2, `两句：${JSON.stringify(L)}`);
  ok(L[0] === '用户问内存够不够用', '尾部标点去掉了（不是文稿，是自我对话）');
  ok(L.every((x) => !x.includes('。')), '每行不以句号结尾');
}

console.log('\n思考：英文句不显示（线上实测原样）');
{
  /* 2026-10-23 真实返回：没要求"思考用中文"时 V4.1-Flash 就这么想 */
  const en = 'Need to report. Maybe also scene_show? The tool is a device assistant. '
    + 'I think calling scene_show with reading is appropriate to display';
  ok(reasonLines(en).length === 0, '纯英文 → 一条都不显示（英文夹在中文界面里比不显示更糟）');
  ok(reasonLines('好的。').length === 0, '太短的碎片不要');
  ok(reasonLines('').length === 0 && reasonLines(undefined).length === 0, '空/undefined → 空数组');
}

console.log('\n思考：中英混排只留中文句');
{
  const L = reasonLines('用户想知道装了哪些应用。I need to call olares with op=apps. '
    + '这个工具会返回应用清单、版本和来源。然后画三个仪表。');
  ok(L.length === 3, `留下三句中文：${JSON.stringify(L)}`);
  ok(!L.some((x) => /^[A-Za-z]/.test(x)), '没有一句以英文开头（英文句被切掉并丢弃）');
  ok(L.some((x) => x.includes('应用清单')), '英句后面的中文还是完整的一句（没被当成同一句截掉）');
}

console.log('\n思考：一句话里夹中文也骗不过去');
{
  /* 2026-10-23 线上原样：这句中文占了五成，光看整句占比是拦不住的 */
  const half = 'User asks "挑一个占内存最多的说说" — the user wants me to pick the biggest one';
  ok(reasonLines(half).length === 0, '半中半英 → 一条都不显示');
  /* 反过来，专有名词开头的正经中文句子不能被误杀 */
  ok(reasonLines('n8n 占内存最多：355MB，2.2%节点').length === 1, '"n8n 占内存最多…" 要留下');
  ok(reasonLines('CPU 21% 和内存 41%，都不高').length === 1, '"CPU 21% 和内存…" 要留下（前 10 字有汉字）');
}

console.log('\n思考：有的模型把标签原样吐出来');
{
  const L = reasonLines('\n<think>\n好的，用户问机器现在忙不忙。根据之前的指示，我需要先调用 sys_status 工具。');
  ok(!L.join('').includes('think'), '标签被剥掉');
  ok(L.some((x) => x.includes('sys_status')), '工具名的下划线**不能**被当成 markdown 抹掉（会变成 sysstatus）');
}

console.log('\n思考：条数与长度');
{
  const long = Array.from({ length: 20 }, (_, i) => `这是第${i}句用来测试上限的思考内容。`).join('');
  const L = reasonLines(long, 4);
  ok(L.length === 4, `最多 4 条，实际 ${L.length}`);
  ok(L.every((x) => Array.from(x).length <= 30), `每行不超过 30 字：${L.map((x) => Array.from(x).length)}`);
  ok(reasonLines(long, 0).length === 0, 'max=0 → 空（上限是可用量的函数）');
}

console.log('\n思考：相近的两句算"说过"');
{
  /* 2026-10-23 线上原样：同一轮的两步里它把同一件事想了两遍，只差一个"并" */
  ok(alike('用户问装了哪些应用，挑一个占内存最多的说说', '用户问装了哪些应用，并挑一个占内存最多的说说'),
    '差一个字的两句 → 相似（按整句比拦不住，屏幕上会连两行一样的）');
  ok(!alike('用户问装了哪些应用', 'n8n 占内存最多：355MB，2.2%节点'), '不同的事 → 不相似');
  ok(!alike('n8n 占内存最多', '所有应用都正常'), '短句也不许乱判');
  ok(alike('好的', '好的'), '完全相同 → 相似');
  ok(!alike('', '任意一句'), '空串不跟任何东西相似（否则第一句会被自己吃掉）');
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
