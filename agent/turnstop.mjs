/**
 * 收口的**措辞**，从网络里剥出来。
 *
 * 为什么单独一个文件：这几件事（心跳那句、要结论的那段提示、模型彻底不说话时说什么、
 * 界面上那行原因）是"这一轮必须有结局"里唯一能**脱离 HTTP 验证**的部分，
 * 而它们在 CI 上恰恰是最该被钉住的 —— 上一版把它们埋在 `server.mjs` 的闭包里，
 * 只能起一个真 server 去测，而 GitHub runner 的本机回环不可靠
 * （实测：同一个地址，`fetch` 报 ECONNREFUSED、`http.get` 却拿到 503），
 * 于是这道闸在 CI 里等于没有。
 *
 * 纪律：这个文件**不许** require 任何 server 状态。进去的是数字，出来的是句子。
 */
import { toolLine } from './trace.mjs';

/** 秒数说成人话。"2 分 10 秒"比 "130s" 好读，而且不会被念成一串数字。 */
function dur(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

/**
 * `stop` 的原因说成人话（给观察窗那一行用）。
 *
 * `cap` 只在**用户自己设了上限**时才会出现 —— 默认不设限（0 = 不限）。
 * 这一点很容易在措辞里露馅：以前这句是"工具次数用尽"，
 * 而现在默认没有"用尽"这回事，说"次数用尽"会让用户以为又在偷偷掐他。
 */
export function stopWord(why) {
  return ({
    cap: '到了你设的步数上限',
    long: '跑太久了，先停在这儿',
    ctx: '上下文快满了',
    budget: '这一轮的花费到顶了',
    stuck: '原地打转',
    silent: '模型空回复',
  })[why] || String(why || '停下');
}

/**
 * 长任务的心跳。**长任务最怕的不是慢，是安静。**
 *
 * 用户看到的是一屏粒子在抖、一句话没有 —— 和"卡死了"没有区别，
 * 于是他会去刷新、会以为坏了。每 45 秒说一句"第几步 / 多久 / 调了几次工具"，
 * 成本几乎为零，但它把"在干活"和"死了"分开了。
 *
 * 有单价时顺带报一句花了多少：不设步数上限之后，一轮真能花掉几毛钱，
 * 而"花了多少"必须在花的过程中看得见 —— 等到轮末才显示，人已经觉得被坑了。
 * 单价未知（`null`）时**不写**，不拿 0 冒充。
 */
export function progressLine({ step = 0, ms = 0, acts = 0, cost = null } = {}) {
  const bits = [`第 ${step} 步`, `已 ${dur(ms)}`];
  if (acts) bits.push(`调了 ${acts} 次工具`);
  if (typeof cost === 'number' && cost > 0) bits.push(`约 ¥${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`);
  return `还在跑：${bits.join(' · ')}`;
}

/**
 * 被硬上限拦下时，用户下一步该说什么。
 *
 * 这条线索是整套"不设限"里的另一半：**停下不等于结束**。
 * 前面查到的全在历史里，用户一句「继续」就能接着走 ——
 * 不说这句话，用户会以为这轮已经收尾了，然后再问一遍新的问题。
 */
export function resumeHint(why) {
  return ({
    cap: '说「继续」就接着来 —— 前面查到的都还在。',
    long: '说「继续」就接着查 —— 前面查到的都还在。',
    ctx: '说「继续」会从刚才那儿接着做（更早的结果已经折叠）。',
    budget: '说「继续」就接着来（记得先看看今天的额度）。',
  })[why] || '';
}

/**
 * 收口时问模型的那段话。
 *
 * 三条都踩过：① 不写"不要再调工具"，它会继续调（工具撤了也没用，7B 会硬发）；
 * ② 不写"不要道歉"，它会回一句"很抱歉我无法完成"，一句话占满一屏、零信息；
 * ③ 不写"查不到就说查了什么"，它会装作查到了。
 *
 * 第四条是"不再设次数上限"之后加的：被硬上限拦下的那一轮**常常还没做完**，
 * 所以要的不是"结论"，是**中途汇报 + 下一步**。写成"总结陈词"的话，
 * 模型会把半成品说成成品，而用户下一步一定会说「继续」—— 两边对不上。
 */
export function finalizePrompt(why, steps = 0) {
  const reason = ({
    cap: `这一轮已经调了 ${steps} 次工具，到了你设的上限。`,
    long: `这一轮跑了很久（${steps} 次工具），先停在这儿。`,
    ctx: `这一轮已经调了 ${steps} 次工具，上下文快满了，后面的结果塞不进去。`,
    budget: `这一轮已经调了 ${steps} 次工具，花费到顶了。`,
    stuck: '你连着几次在调同一个工具、同一组参数，没有进展。',
    silent: '你刚才那句话是空的，屏幕上什么都没有。',
  })[why] || '这一轮停下来了。';
  const midway = why === 'long' || why === 'ctx' || why === 'budget' || why === 'cap';
  return `${reason}现在不要再调工具（工具已经关掉了），`
    + '用**已经拿到的结果**直接回答用户刚才的问题。'
    + '如果没查到想要的，就说清楚：查了什么、拿到了什么、卡在哪一步。'
    + (midway ? '还没做完的话，最后用一句话说下一步打算查什么 —— 用户说「继续」就会接着来。' : '')
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
 * @param {number} [total] 真实调用次数（acts 有上限 12 条，长任务会截断）
 */
export function closeLine(acts = [], why = '', total = 0) {
  const list = (acts || []).filter((a) => !a.denied);
  if (!list.length) {
    /* 一步都没走成：它连工具都没调。原因只可能在模型那边（空回复、被截断）。 */
    return '这次我没能给出回答 —— 模型返回的是空的。要我再来一次吗？';
  }
  const n = Math.max(list.length, Number(total) || 0);
  const verbs = [...new Set(list.map((a) => {
    try { return toolLine(a.name, {}).verb; } catch { return '查了一下'; }
  }))].slice(0, 3);
  const bad = list.filter((a) => a.ok === false).length;
  const tail = why === 'long' ? '先停在这儿，说「继续」我接着查。'
    : why === 'ctx' ? '先停在这儿 —— 再往下查，前面的结果就要被折叠了。'
      : why === 'stuck' ? '我一直在查同一个地方，卡住了。'
        : why === 'cap' ? '要接着查就说一声。'
          : '';
  const what = verbs.length ? `（${verbs.join('、')}）` : '';
  return `我查了 ${n} 次${what}${bad ? `，其中 ${bad} 次没成` : ''}，`
    + `但没能把这些串成答案。${tail}`;
}
