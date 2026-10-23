/**
 * 它说的话里，哪些不该上屏。
 *
 * 屏幕是粒子：一行 400 字的一页，块多一个字符就少一句正文。而 7B 有三样毛病
 * 长在同一个地方 —— **它会把自己的草稿当成回答的一部分写出来**：
 *
 *   ① 正文后面接"第 1 步，调 logs_tail… 第 2 步，调 scene_show…"（线上实拍）
 *   ② 参数 JSON 包在 ``` 代码块里（`{"reading":"CPU 21% · 内存 41%"` 原样上屏）
 *   ③ 行首的舞台提示（`{手势} 把「内存」从 48% 拖到 34%`）
 *
 * 三条里 ③ 已经在 server 的 HEAD_TAG 里挡掉了；①②在这里挡。
 *
 * 为什么是"从这一行开始切"而不是"过滤掉这一行"：
 * 一旦它开始写步骤，后面每一行都是同一种东西，留着就是一个半截清单。
 * 而**正文里偶然提到工具名**（"我查了一下 pod 的事件"）不算 —— 只在行首、
 * 且只在步骤句式上才切，正文一个字都不动。
 */

/** 一行开头像"步骤说明"的：那是它给自己下的指令，不是回答。 */
const PLAN_LINE = /^\s*(第\s*\d+\s*步|步骤\s*\d|接下来(我|要|会|还)|下一步|然后(调|我|再)|先调|参数(长这样|是))[：:，,]?/;

/** 一行像参数的 JSON 残片。
 *  不枚举键名 —— 实测漏了一个键就放过一整行：模型把选项写成了
 *  `{"label":"要看日志吗","yes":"看看","no":"先看着"}`（2026-10-22 线上）。
 *  一行以 `{`/`[` 开头且紧跟着 `"键":` 的，在自然语言里没有正经用途。 */
const JSON_LINE = /^\s*[[{]\s*"[A-Za-z_]+"\s*:/;

/** 模型用"XML 文本"表达的工具调用（DeepSeek 的 `<｜DSML｜ invoke …>`、
 *  Qwen 的 `<tool_call>`、Anthropic 的 `<antml:invoke>`，都是同一类东西）。
 *
 *  **它只在一种情况下出现：工具表被撤掉、而模型仍然想调工具。**
 *  也就是"收口"那一次（见 server.mjs 的 `finalize`）—— 它想把 reading 说出来、
 *  想铺一屏，但手上没有 tools 可用，于是把调用写成了文本。
 *
 *  整段上屏就是一片尖括号（实测原样上屏过），而**答案其实藏在
 *  `name="reading"` 那个参数里**。所以这里先抽它，抽不到就把标签全去掉、
 *  取最长的文本节点；都不行返回空，由上层走"系统说实话"那条路。
 */
const MARKUP = /<[｜|]?\s*(DSML|tool_call|function_call|invoke|parameter|antml)[^>]{0,120}>/i;

export function demarkup(t) {
  const s = String(t || '');
  if (!MARKUP.test(s)) return s;
  /* ① 它把想说的话写在 reading 参数里了（最常见的一种） */
  const m = s.match(/parameter\s+name\s*=\s*["']reading["'][^>]*>([\s\S]*?)<\//);
  if (m) return m[1].trim();
  /* ② 退一步：去掉所有标签，取最长的那个文本节点 */
  const nodes = s.split(/<[^>]{1,200}>/).map((x) => x.trim()).filter((x) => x.length > 8);
  if (nodes.length) return nodes.sort((a, b) => b.length - a.length)[0];
  return '';
}

/**
 * @param {string} t
 * @returns {string}
 */
export function cleanSpeech(t) {
  let s = demarkup(String(t || ''));
  /* 代码块整段去掉。**含没闭合的** —— 7B 经常忘了收尾，
     只匹配成对的会把后半截全留下（那半截正是 JSON 参数）。 */
  s = s.replace(/```[\s\S]*?(```|$)/g, '');
  const out = [];
  for (const ln of s.split('\n')) {
    if (PLAN_LINE.test(ln) || JSON_LINE.test(ln)) break;
    out.push(ln);
  }
  return out.join('\n').trim();
}
