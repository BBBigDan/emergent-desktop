/**
 * 分叉问句的断行。
 *
 * 为什么单独一个文件：它是**纯字符串函数**，而 scene.js 那条链会一路拉到 three，
 * 在 node 里根本 import 不了 —— 于是"断得好不好"这件事就没法单测。
 * 这个判断很容易错（第一版把问句切成「要在 Navidrome 中…」半句话上了屏），
 * 所以它值得一个能跑的自测。
 *
 * 规则：
 *   · 一行最多 n 个字（默认 15，17px 点阵下约 280px，环心两侧还留给连线）；
 *   · 最多两行 —— 第三行会压到选项上；
 *   · 断点优先标点/空格，其次硬切，末尾放不下就补省略号。
 *
 * @param {string} text
 * @param {number} [n]
 * @returns {string[]} 1~2 行
 */
export function splitTitle(text, n = 15) {
  const ch = Array.from(String(text ?? '').trim());
  if (!ch.length) return [];
  if (ch.length <= n) return [ch.join('')];
  /* 断点窗口从 n 往回找，下限放到 0.3n：宁可第一行短一点，也别硬切半句。
     踩过：下限写成 0.5n，逗号在更靠前的位置就找不到，于是硬切 ——
     「先看看磁盘，然后我们再决定要不」这种一行，读起来像被谁掐断了。 */
  const floor = Math.max(1, Math.floor(n * 0.3));
  let cut = n;
  for (let i = Math.min(n, ch.length - 1); i >= floor; i--) {
    if ('，,、。；;：: ？?！!'.includes(ch[i])) { cut = i + 1; break; }
  }
  const a = ch.slice(0, cut).join('').trim();
  const rest = ch.slice(cut);
  const b = (rest.length > n ? `${rest.slice(0, n - 1).join('')}…` : rest.join('')).trim();
  return [a, b].filter(Boolean);
}
