/**
 * 收口的**措辞**，从网络里剥出来。
 *
 * 为什么单独一个文件：这三件事（要结论的那段提示、模型彻底不说话时说什么、
 * 界面上那行原因）是"这一轮必须有结局"里唯一能**脱离 HTTP 验证**的部分，
 * 而它们在 CI 上恰恰是最该被钉住的 —— 上一版把它们埋在 `server.mjs` 的闭包里，
 * 只能起一个真 server 去测，而 GitHub runner 的本机回环不可靠
 * （实测：同一个地址，`fetch` 报 ECONNREFUSED、`http.get` 却拿到 503），
 * 于是这道闸在 CI 里等于没有。
 *
 * 纪律：这个文件**不许** require 任何 server 状态。进去的是数字，出来的是句子。
 */
import { toolLine } from './trace.mjs';

/** `stop` 的四种原因说成人话（给观察窗那一行用）。 */
export function stopWord(why) {
  return ({
    cap: '工具次数用尽',
    slow: '时间到',
    stuck: '原地打转',
    silent: '模型空回复',
  })[why] || String(why || '停下');
}

/**
 * 收口时问模型的那段话。
 *
 * 三条都踩过：① 不写"不要再调工具"，它会继续调（工具撤了也没用，7B 会硬发）；
 * ② 不写"不要道歉"，它会回一句"很抱歉我无法完成"，一句话占满一屏、零信息；
 * ③ 不写"查不到就说查了什么"，它会装作查到了。
 */
export function finalizePrompt(why, steps = 0) {
  const reason = ({
    cap: `这一轮已经调了 ${steps} 次工具，次数到上限了。`,
    slow: '这一轮花的时间太长了，先停在这儿。',
    stuck: '你连着几次在调同一个工具、同一组参数，没有进展。',
    silent: '你刚才那句话是空的，屏幕上什么都没有。',
  })[why] || '这一轮停下来了。';
  return `${reason}现在不要再调工具（工具已经关掉了），`
    + '用**已经拿到的结果**直接回答用户刚才的问题。'
    + '如果没查到想要的，就说清楚：查了什么、拿到了什么、卡在哪一步。'
    + '2~5 句，直接说结论。不要说抱歉，也不要解释这件事本身。';
}

/**
 * 模型连"总结一下"都不说时，**系统说哪一句**。
 *
 * 两条硬规矩：
 *   ① **不装作答上了。** 说"我查了 N 次…没能串成答案"，而不是"这就是结果"。
 *   ② **只用这一轮真的发生过的事。** 调过什么工具、几次没成，都是事实；
 *      而拿一段旧记忆顶上（原来那条兜底就是这么干的）是答非所问 ——
 *      用户会以为它答了，只是答歪了。那比空白更糟。
 *
 * @param {{name:string, ok?:boolean, denied?:boolean}[]} acts 这一轮真调过的工具
 * @param {string} why
 */
export function closeLine(acts = [], why = '') {
  const list = (acts || []).filter((a) => !a.denied);
  if (!list.length) {
    /* 一步都没走成：它连工具都没调。原因只可能在模型那边（空回复、被截断）。 */
    return '这次我没能给出回答 —— 模型返回的是空的。要我再来一次吗？';
  }
  const verbs = [...new Set(list.map((a) => {
    try { return toolLine(a.name, {}).verb; } catch { return '查了一下'; }
  }))].slice(0, 3);
  const bad = list.filter((a) => a.ok === false).length;
  const tail = why === 'slow' ? '这次太慢了，先停在这儿。'
    : why === 'stuck' ? '我一直在查同一个地方，卡住了。'
      : why === 'cap' ? '要接着查就说一声。'
        : '';
  const what = verbs.length ? `（${verbs.join('、')}）` : '';
  return `我查了 ${list.length} 次${what}${bad ? `，其中 ${bad} 次没成` : ''}，`
    + `但没能把这些串成答案。${tail}`;
}
