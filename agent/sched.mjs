/**
 * 定时任务（roadmap ①「定时与主动」的服务端一半）
 *
 * 这一层只管**什么时候该开一轮**，不关心那一轮怎么跑 —— 开轮的事在 server.mjs。
 * 分开的理由：时间算术是最容易写错、又最容易测住的一块，不该和 SSE、审批门缠在一起。
 *
 * ── 三条设计判据 ──
 *
 * 1. **定时不是"提醒"，是"到点自己再开一轮"。**
 *    提醒只需要一根定时器；开一轮意味着它会在没人看着的时候调工具、说话、落会话。
 *    所以任务里存的是**一句任务话术**（"看一眼 n8n 重启次数"），不是一条字符串通知。
 *
 * 2. **补跑只补一次。**
 *    pod 重启、整机被别的负载压死、凌晨没人管 —— 醒来时 nextAt 可能已经过去 6 个周期。
 *    照 due 列表逐条补跑，用户一睁眼会收到一串一模一样的结论。
 *    所以：过期就**只跑一次**，然后从 now 重新排。
 *
 * 3. **结论一样就降频，不是静音。**
 *    "每 5 分钟看 n8n"，正常的时候它每 5 分钟说一遍"还是好的" —— 那不是信息，是噪音；
 *    但静音的代价是坏掉时也不说。折中是**放大间隔**（×2，上限 ×8），
 *    并在结果里如实说"没变化，我把它放宽到每 40 分钟了"。
 *
 * 时间一律按**服务器本地时区**算（部署里 TZ=Asia/Shanghai）。
 * `at` 型任务因此不受夏令时影响 —— 这个箱子的用户在中国。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/* 一分钟一次太密（一秒一次纯浪费），太快又会让"每 5 分钟"最多晚 30 秒。
   30 秒是这两件事的折中：用户感觉不到晚，进程每秒只醒两次。 */
export const TICK_MS = 30_000;

/** 最短间隔。低于一分钟的任务没有意义 —— 每一轮都是一份完整上下文 + 若干次工具调用。 */
const MIN_EVERY_MS = 60_000;
/** 一个用户最多挂多少个 —— 防"每 30 分钟加一个"加到天荒地老（也防模型自我繁殖）。 */
const MAX_TASKS = 20;
/** 连续几次结论相同开始降频 */
const SAME_LIMIT = 3;
/** 降频上限（间隔最多放大到 8 倍） */
const SLOW_CAP = 8;
/** 过期超过这么多个周期就只补跑一次（见文件头第 2 条） */
const CATCHUP_MAX = 3;

const UNIT_MS = {
  m: 60_000, 分: 60_000, 分钟: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, 时: 3_600_000, 小时: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, 天: 86_400_000, day: 86_400_000, days: 86_400_000,
};

const pad2 = (n) => String(n).padStart(2, '0');

/* 全角数字、全角冒号、顿号……模型抄用户的话时这些都会混进来。
   统一半角之后再解析 —— 否则 `每天８:００` 会被判成"看不懂"。 */
function norm(s) {
  return String(s || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\uFF1A\uFF1B]/g, ':')
    .replace(/\s+/g, '')
    .replace(/[，,。；;]/g, '')
    .trim();
}

/**
 * 把模型填的 `when` 解析成调度意图。
 *
 * 宽容到什么程度：**比 schema 描述更宽**。7B 不会照 description 的格式填，
 * 它会把用户的原话抄进来（"每 15 分钟"、"每天早上八点"）。写死格式的结果是
 * 用户说对了、系统说看不懂 —— 那是系统的问题，不是用户的。
 *
 * 返回 `{ everyMs }` 或 `{ at: { h, m } }`；看不懂返回 `{ error }`（带可照抄的例子）。
 */
export function parseWhen(input) {
  const t = norm(input)
    /* 「8 点半」先换成 8:30 —— 中文口语里这个时间点太常见，
       不处理的话 `8点半` 会被当成"看不懂"，而用户觉得自己说得很清楚。 */
    .replace(/(\d{1,2})点半/, '$1:30')
    .replace(/(\d{1,2})点整/, '$1:00');
  if (!t) return { error: '没说要多久一次。写「每 15 分钟」或「每天 08:00」这种。' };

  /* ── 每天固定时刻 ── */
  const daily = t.match(/^(?:daily|每天|每日)?(?:@|at|的)?(\d{1,2})[:：点时](\d{1,2})?(?:分)?$/)
    || t.match(/^(?:daily|每天|每日)@(\d{1,2}):(\d{1,2})$/);
  if (daily) {
    const h = Number(daily[1]);
    const m = Number(daily[2] || 0);
    if (h > 23 || m > 59) return { error: `${h}:${pad2(m)} 不是有效时刻。` };
    return { at: { h, m } };
  }
  /* "每天" 单独出现：没给时刻，别替它猜一个 —— 猜错了是"每天中午吵一次" */
  if (/^(daily|每天|每日)$/.test(t)) {
    return { error: '「每天」要带时刻，例如「每天 08:00」。' };
  }

  /* ── 固定间隔 ── */
  /* "每小时 / 每分钟" 这种不带数字的写法 */
  const bare = t.match(/^每?(小时|分钟|天)$/);
  if (bare) return { everyMs: UNIT_MS[bare[1]] };

  const iv = t.match(/^(?:每|每隔|every)?(\d+(?:\.\d+)?)(分钟|分|小时|时|天|m|min|minutes?|h|hours?|d|days?)$/i);
  if (iv) {
    const n = Number(iv[1]);
    const unit = iv[2].toLowerCase();
    const ms = Math.round(n * (UNIT_MS[unit] || UNIT_MS[unit.replace(/s$/, '')] || 0));
    if (!ms) return { error: `看不懂「${input}」的单位，用 分钟/小时 或 m/h。` };
    if (ms < MIN_EVERY_MS) {
      return { error: `最短一分钟一次（你写的是 ${Math.round(ms / 1000)} 秒）。` };
    }
    return { everyMs: ms };
  }

  return {
    error: `看不懂「${input}」。能用的写法：「每 15 分钟」「每 2 小时」「每天 08:00」。`,
  };
}

/** 间隔的人话（"每 5 分钟" / "每 40 分钟" / "每天 08:00"） */
export function whenText(t) {
  if (t.at) return `每天 ${pad2(t.at.h)}:${pad2(t.at.m)}`;
  const ms = effEvery(t);
  if (ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `每 ${ms / 60_000} 分钟`;
  return `每 ${Math.round(ms / 1000)} 秒`;
}

/** 实际生效的间隔：已被降频的会放大（见文件头第 3 条） */
function effEvery(t) {
  return Math.round((t.everyMs || 0) * (t.factor || 1));
}

function atTime(base, at) {
  const d = new Date(base);
  d.setHours(at.h, at.m, 0, 0);
  return d.getTime();
}

/**
 * 下一次该在什么时候跑。`from` 是"从哪一刻往后算"。
 * 固定时刻的语义是**下一次出现的那个点**（今天还没到就今天，过了就明天）。
 */
export function nextAt(t, from = Date.now()) {
  if (t.at) {
    const today = atTime(from, t.at);
    if (today > from) return today;
    return atTime(from + 86_400_000, t.at);
  }
  return from + effEvery(t);
}

/** 给模型看的时刻（今天 / 明天 + HH:MM），模型要把这句复述给用户 */
export function atLabel(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  const tmw = new Date(now + 86_400_000).toDateString() === d.toDateString();
  const day = sameDay ? '今天' : tmw ? '明天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const hash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);

/**
 * 任务表。所有磁盘读写都在这一层，server 只拿内存里的数组。
 *
 * `file` 默认 `agent/config/tasks.json`（和 settings.json 同一个挂载点，
 * pod 重建不丢）。数组写坏时**返回空表并留一条 warn**，不是抛异常 ——
 * 一个坏文件不该让整个 agent 起不来。
 */
export function createSched({ file, now = () => Date.now(), warn = console.warn } = {}) {
  const list = [];
  let loaded = false;

  async function load() {
    if (loaded) return list;
    loaded = true;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (!t || !t.id || !t.task) continue;
          /* 从磁盘回来的任务**保留原来的 nextAt**（哪怕已经过期）。
             过期的会在下一次 tick 里被跑到，且只跑一次（见 `begin` 的 from）——
             这是"箱子关了一夜，早上打开先看一眼"的正确行为。
             反过来"按 now 重排"会让重启等于静默跳过一次检查。 */
          list.push({ ...t, running: false });
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') warn('[sched] 任务表读不出来，当作空的：' + e.message);
    }
    return list;
  }

  async function save() {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      /* 写临时文件再 rename：直接覆盖时进程被杀会留下半个 JSON，
         下次启动整个任务表就变成空的（而且没有任何报错）。 */
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (e) {
      warn('[sched] 任务表写不进去：' + e.message);
    }
  }

  function find(idOrText) {
    const k = norm(idOrText).toLowerCase();
    if (!k) return null;
    /* 认三种指法：完整 id、id 前缀、任务原话的一段。7B 经常只回一个序号，
       server 会先把序号翻译成 id 再进来（见 tools 那边的 schedule）。 */
    return list.find((t) => t.id === k)
      || list.find((t) => t.id.startsWith(k))
      || list.find((t) => norm(t.task).toLowerCase().includes(k))
      || null;
  }

  return {
    list: () => list,

    /** 启动时调一次：读盘。返回条数（打日志用）。 */
    async init() {
      await load();
      return list.length;
    },

    /**
     * 只看某个会话的任务（`sid` 不传 = 全部）。
     *
     * hello 事件要的是**全部**：任务属于这台机器，不属于某一段对话。
     * 只在某个 sid 里能看到的话，换个浏览器/开个新会话，用户会以为任务没了
     * （而它还在后台跑，结论落进一个他再也不会打开的会话）。
     */
    forSid(sid) {
      return list.filter((t) => !sid || t.sid === sid).map((t) => ({
        id: t.id, when: whenText(t), task: t.task, nextAt: t.nextAt,
        next: atLabel(t.nextAt, now()), paused: !!t.paused, runs: t.runs || 0,
        slow: (t.factor || 1) > 1 ? t.factor : 1,
      }));
    },

    /**
     * 换会话（`/new`）时把任务搬过去。
     *
     * 不搬的话，结论会一直落进**归档掉的那段会话**：用户开着新对话，
     * 等一晚上什么都没收到 —— 而任务其实准时跑了，只是说给了空气听。
     */
    async rekey(fromSid, toSid) {
      await load();
      if (!fromSid || !toSid || fromSid === toSid) return 0;
      let n = 0;
      for (const t of list) if (t.sid === fromSid) { t.sid = toSid; n += 1; }
      if (n) await save();
      return n;
    },

    /**
     * 加一条。同样的任务话术只留一条 —— 用户连着说两遍"每小时看一眼 n8n"，
     * 不该变成两个任务同时开火（那就是每次两轮、两份钱）。
     */
    async add({ sid, task, when, quiet = false }) {
      await load();
      const text = String(task || '').trim();
      if (!text) return { ok: false, error: '任务要写成一句话，例如「看一眼 n8n 有没有又重启」。' };
      const w = parseWhen(when);
      if (w.error) return { ok: false, error: w.error };

      const dup = list.find((t) => t.sid === sid && norm(t.task) === norm(text));
      if (dup) {
        return {
          ok: true, dup: true, id: dup.id, when: whenText(dup),
          next: atLabel(dup.nextAt, now()),
          message: '这条已经有了，没重复加。',
        };
      }
      if (list.length >= MAX_TASKS) {
        return { ok: false, error: `任务太多了（上限 ${MAX_TASKS} 个）。先取消几个。` };
      }

      const t = {
        id: 't' + crypto.randomBytes(3).toString('hex'),
        sid, task: text,
        everyMs: w.everyMs || 0,
        at: w.at || null,
        factor: 1,
        runs: 0,
        same: 0,
        lastHash: '',
        createdAt: now(),
        lastAt: 0,
        nextAt: 0,
        paused: false,
      };
      t.nextAt = nextAt(t, now());
      list.push(t);
      await save();
      return {
        ok: true, id: t.id, when: whenText(t),
        next: atLabel(t.nextAt, now()),
        message: `记下了：${whenText(t)}，下次 ${atLabel(t.nextAt, now())}。`,
      };
    },

    async cancel(idOrText) {
      await load();
      const t = find(idOrText);
      if (!t) return { ok: false, error: '没找到这个任务。用 op=list 看一眼有哪些。' };
      const i = list.indexOf(t);
      list.splice(i, 1);
      await save();
      return { ok: true, id: t.id, message: `取消了：${t.task}` };
    },

    async pause(idOrText, on = true) {
      await load();
      const t = find(idOrText);
      if (!t) return { ok: false, error: '没找到这个任务。用 op=list 看一眼有哪些。' };
      t.paused = !!on;
      if (!on) t.nextAt = nextAt(t, now());
      await save();
      return { ok: true, id: t.id, paused: t.paused, when: whenText(t) };
    },

    /** 到点、没在跑的任务（按 nextAt 排，最该跑的先） */
    due(at = now()) {
      return list
        .filter((t) => !t.paused && !t.running && t.nextAt <= at)
        .sort((a, b) => a.nextAt - b.nextAt);
    },

    /**
     * 开始跑。返回 true 表示"这次归你了"，false 表示状态已经变了（被取消/暂停）。
     * 先把 nextAt 推到未来再跑 —— 跑的过程中进程被杀，也不会醒来又跑一遍。
     */
    begin(t, at = now()) {
      if (!t || t.paused || t.running || !list.includes(t)) return false;
      t.running = true;
      t.lastAt = at;
      t.runs = (t.runs || 0) + 1;
      /* 过期太久只算一次：从 now 往后排，不是从 nextAt 一格一格补（见文件头第 2 条） */
      const late = at - t.nextAt;
      const from = late > effEvery(t) * CATCHUP_MAX ? at : Math.max(at, t.nextAt);
      t.nextAt = nextAt(t, from);
      return true;
    },

    /**
     * 跑完了。`text` 是这一轮它说出的话 —— 和上次一样就把连续次数加一，
     * 到 SAME_LIMIT 开始降频（不改 everyMs，只放大 factor，用户还能看见原始频率）。
     *
     * `same` 数的是"**连续看到同样的结论**几次"，所以第一次看见就是 1，
     * 不是 0 —— 否则阈值 3 会变成"第 4 次才降频"，和文档里说的对不上。
     */
    settle(t, { text = '', ok = true } = {}) {
      if (!t) return null;
      t.running = false;
      /* 这一轮失败 / 一句话都没说：既不算"一样"，也不算"有变化"。
         把它算成"有变化"会在每次接口 429 时重置降频，等于降频从来没生效过。 */
      if (!ok || !text) {
        save();
        return { slowed: false, factor: t.factor || 1, next: atLabel(t.nextAt, now()) };
      }
      const h = hash(text);
      const same = h === t.lastHash;
      if (same) t.same = (t.same || 1) + 1;
      else { t.same = 1; t.lastHash = h; }

      let slowed = false;
      if (t.same >= SAME_LIMIT && (t.factor || 1) < SLOW_CAP) {
        t.factor = Math.min(SLOW_CAP, (t.factor || 1) * 2);
        /* 间隔变了，"下一次"要按新间隔重排；否则降频只是改了名字、没往后推 */
        t.nextAt = nextAt(t, Math.max(now(), t.lastAt));
        slowed = true;
      } else if (!same && (t.factor || 1) > 1) {
        /* 有变化 = 恢复原频率。降频是为了不吵，不是为了永久阉掉它。 */
        t.factor = 1;
        t.nextAt = nextAt(t, Math.max(now(), t.lastAt));
      }
      save();
      return { slowed, factor: t.factor || 1, next: atLabel(t.nextAt, now()) };
    },

    /* 测的时候要能重置，不然一个测试文件里几条用例互相污染 */
    _reset() { list.length = 0; loaded = false; },
    _save: save,
  };
}
