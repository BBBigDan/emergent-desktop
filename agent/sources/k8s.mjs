/**
 * 集群采集层 —— 场上的数字从哪里来
 *
 * 为什么是「直连 k8s API」而不是调 kubectl：
 *   1. 零依赖。kubectl 是个 60MB 的二进制，这个仓库的约定是部署时不需要装任何东西。
 *   2. 一条链路够用。k8s API 的 service proxy 让我们**只用一个 HTTPS 端点**
 *      就能访问集群里任何 Service（Prometheus 就是靠它），不必 port-forward、
 *      不必暴露 ClusterIP。
 *   3. 同一份代码在两种部署下都能跑：本机靠 kubeconfig + 公网 6443，
 *      进了集群靠 serviceaccount（`/var/run/secrets/...`）。
 *
 * 数据源分两层，因为它们回答的问题不同：
 *   · 此刻是多少     → Prometheus 瞬时查询（node-exporter 的 15s 采样）
 *   · 这一小时怎么变 → Prometheus query_range
 *   · 谁在吃          → container_memory_working_set_bytes（kubectl top 不可用，
 *                     这个集群没装 metrics-server；但 Prometheus 一直在采）
 *   · 应用是什么状态 → k8s API 的 deployment / pod 对象（Prometheus 不知道"应用"）
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const GB = 1024 ** 3;

const PROM_NS = process.env.PROM_NS || 'kubesphere-monitoring-system';
const PROM_SVC = process.env.PROM_SVC || 'prometheus-k8s:9090';
const PROM_PATH = `/api/v1/namespaces/${PROM_NS}/services/${PROM_SVC}/proxy`;

/* Olares 给每个用户的命名空间是 <app>-<用户名>。
   从 kubeconfig 里推不出来（那只是集群凭据），所以先看环境变量，
   再退化到"找后缀出现次数最多的那个" —— 这台机器上装的应用都在自己名下，
   统计一下就知道用户名，不用让用户去填。 */
function detectUserSuffix(namespaces) {
  /* 环境变量**必须验证**再用。踩过的坑：yaml 里写成 bbigdan（两个 b），
     真实用户名是 bbbigdan（三个 b）—— 于是 isMine() 对每个命名空间都返回 false，
     应用列表永远是空的，而且不报错。用户问"装了什么"，屏幕上就是"没有应用在运行"。
     对不上就退回统计：这台机器上装的应用都在自己名下，数一下就知道是谁。 */
  const env = process.env.OLARES_USER;
  if (env) {
    /* 只认"真的存在这个后缀"，不认声明 */
    if (namespaces.some((ns) => ns.endsWith(`-${env}`))) return env;
    console.warn(`[k8s] OLARES_USER=${env} 与命名空间对不上，改用统计推断`);
  }
  const tally = new Map();
  for (const ns of namespaces) {
    const m = ns.match(/^[a-z0-9-]+?-([a-z][a-z0-9]{3,})$/);
    if (!m) continue;
    if (/^(system|space|framework|platform|gateway|mesh|network|protected|gpu|protected)$/.test(m[1])) continue;
    tally.set(m[1], (tally.get(m[1]) || 0) + 1);
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/* ── 指标口径 ──
   这六条 PromQL 是这一层唯一的"知识"。它们决定了场上所有数字的含义，
   所以集中放这里，别散在调用处 —— 口径漂移是监控系统最常见的腐烂方式。 */
export const QUERY = {
  cpu: '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  mem: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  disk: '100 * (1 - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}'
      + ' / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"})',
  memUsed: 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
  memTotal: 'node_memory_MemTotal_bytes',
  /* 容器口径而不是 pod 口径：一个 pod 里可能挂着 linkerd-proxy，
     pod 级会把 sidecar 的内存算进来，那不是用户装的应用。
     不加 topk/limit：这张表要能回答"每个用户应用吃多少"，
     只取前 40 会让排在后面的应用显示成"没有数据"。全量 62 个 pod 才几 KB。 */
  topMem: 'sort_desc(sum by (namespace,pod) (container_memory_working_set_bytes{container!="",container!="POD"}))',
  topCpu: 'sort_desc(sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))',
};

/* ── 凭据 ──
   三选一，按"越靠内越优先"的顺序。in-cluster 放最前：部署进去之后
   即使环境里残留了 KUBECONFIG 也不会读错集群。 */
function loadCreds() {
  /* 1. in-cluster serviceaccount */
  if (fs.existsSync(path.join(SA_DIR, 'token'))) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    if (!host) throw new Error('在集群内但缺少 KUBERNETES_SERVICE_HOST');
    return {
      host,
      port: Number(port),
      ca: fs.readFileSync(path.join(SA_DIR, 'ca.crt')),
      token: fs.readFileSync(path.join(SA_DIR, 'token'), 'utf8').trim(),
      how: 'in-cluster',
    };
  }

  /* 2. kubeconfig（最小的 yaml 提取：只要四个字段，不为它引入 yaml 库） */
  const kubePath = process.env.KUBECONFIG || path.join(HERE, '..', '.kube', 'config');
  if (fs.existsSync(kubePath)) {
    const raw = fs.readFileSync(kubePath, 'utf8');
    const field = (name) => {
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t.startsWith(name + ':')) return Buffer.from(t.slice(name.length + 1).trim(), 'base64');
      }
      return null;
    };
    let server = (raw.match(/^\s*server:\s*(\S+)/m) || [])[1] || '';
    /* k3s 写的 kubeconfig 里 server 是 127.0.0.1:6443 —— 那是**集群内视角**。
       从外面用时必须换掉，否则连的是自己。 */
    if (process.env.KUBE_SERVER) server = process.env.KUBE_SERVER;
    const u = new URL(server);
    return {
      host: u.hostname,
      port: Number(u.port || 6443),
      ca: field('certificate-authority-data'),
      cert: field('client-certificate-data'),
      key: field('client-key-data'),
      how: `kubeconfig(${path.basename(kubePath)})`,
    };
  }

  throw new Error('没有集群凭据：既不在集群内，也没有 kubeconfig');
}

/* ── HTTP ──
   用 node:https 而不是 fetch：原生 fetch（undici）要传客户端证书得自定义 Agent，
   而 https 直接吃 cert/key/ca 三个 Buffer，零依赖更省事。 */
function makeClient(creds) {
  const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 8 });

  return function request(pathname, { timeout = 6000, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const opt = {
        host: creds.host,
        port: creds.port,
        path: pathname,
        method,
        agent: keepAlive,
        timeout,
        ca: creds.ca || undefined,
        cert: creds.cert || undefined,
        key: creds.key || undefined,
      };
      const req = https.request(opt, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const e = new Error(`k8s ${res.statusCode} ${pathname.slice(0, 60)}: ${body.slice(0, 160)}`);
            e.status = res.statusCode;
            reject(e);
          } else resolve(body);
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`k8s 超时 ${timeout}ms ${pathname.slice(0, 50)}`)); });
      req.on('error', reject);
      if (creds.token) req.setHeader('Authorization', `Bearer ${creds.token}`);
      req.end();
    });
  };
}

const json = async (fn, p, o) => JSON.parse(await fn(p, o));

/* ── 采集器 ── */

export function createK8s(o = {}) {
  const creds = loadCreds();
  const req = makeClient(creds);
  const ttl = o.ttl ?? 5000;

  /* 缓存：一轮里模型可能连着调三次工具，节点指标没必要查三遍。
     5 秒 = node-exporter 的采样间隔，比它更细的缓存不会带来任何新信息。 */
  const cache = new Map();
  const memo = async (key, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { at: Date.now(), v });
    return v;
  };

  /* ── Prometheus ── */

  async function promql(q) {
    const body = await json(req, `${PROM_PATH}/api/v1/query?query=${encodeURIComponent(q)}`);
    if (body.status !== 'success') throw new Error(`PromQL 失败：${body.error || 'unknown'}`);
    return body.data.result || [];
  }

  async function promRange(q, { minutes = 60, points = 60 } = {}) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - minutes * 60;
    const step = Math.max(15, Math.round((minutes * 60) / points));
    const p = `${PROM_PATH}/api/v1/query_range?query=${encodeURIComponent(q)}`
      + `&start=${start}&end=${end}&step=${step}`;
    const body = await json(req, p);
    if (body.status !== 'success') throw new Error(`PromQL 失败：${body.error || 'unknown'}`);
    /* 多序列时（比如按 pod 分组）取总和，否则场上的曲线会变成好几条叠在一起，
       而 trace 编码器只画一条。 */
    const rows = body.data.result || [];
    if (!rows.length) return [];
    if (rows.length === 1) return rows[0].values.map(([, v]) => Number(v) / 100);
    const n = rows[0].values.length;
    const acc = new Array(n).fill(0);
    for (const r of rows) r.values.forEach(([, v], i) => { acc[i] += Number(v) / 100; });
    return acc.map((v) => v);
  }

  const scalar = async (q) => {
    const r = await promql(q);
    return r.length ? Number(r[0].value[1]) : null;
  };

  /* ── 工具用的三个读法 ── */

  /** 此刻的三个比例 + 谁在吃。序列不在这里给 —— 见 tools.mjs 的 scene_show。 */
  async function nodeMetrics() {
    return memo('node', async () => {
      const [cpu, mem, disk, used, total, topMem, topCpu] = await Promise.all([
        scalar(QUERY.cpu), scalar(QUERY.mem), scalar(QUERY.disk),
        scalar(QUERY.memUsed), scalar(QUERY.memTotal),
        promql(QUERY.topMem), promql(QUERY.topCpu),
      ]);
      const cpuMap = new Map(topCpu.map((m) => [m.metric.pod, Number(m.value[1])]));
      const rows = topMem.map((m) => ({
        ns: m.metric.namespace,
        pod: m.metric.pod,
        name: shortName(m.metric.pod),
        memMB: Math.round(Number(m.value[1]) / 1048576),
        cpu: cpuMap.get(m.metric.pod) ?? 0,
      }));
      return {
        cpu: clamp01(cpu), mem: clamp01(mem), disk: clamp01(disk),
        memTotal: total ? +(total / GB).toFixed(1) : null,
        memUsed: used ? +(used / GB).toFixed(1) : null,
        memFree: total && used != null ? +((total - used) / GB).toFixed(1) : null,
        top: rows,
      };
    });
  }

  /** 一小时曲线。给 trace 用 —— 模型只说"看哪个指标"，点位由这里取。 */
  async function series(metric, o2 = {}) {
    const q = QUERY[metric];
    if (!q) throw new Error(`没有这个指标：${metric}（可选 cpu / mem / disk）`);
    return memo(`series:${metric}:${o2.minutes || 60}`, () => promRange(q, o2));
  }

  /** 用户命名空间里的"应用"。deployment 是用户的视角，pod 是集群的视角。
   *
   * kind 区分两件事：**用户装的**（n8n / navidrome / qbittorrent，各自有
   * `<app>-<user>` 专属命名空间）和 **Olares 自己的组件**（bfl / authelia /
   * olares-app，都挤在 user-space 里）。用户问"装了什么"时看到 12 个东西
   * 会困惑 —— 他心里的应用只有三个。所以默认只给 kind==='app'。 */
  async function apps({ includeSystem = false } = {}) {
    return memo('apps:' + includeSystem, async () => {
      const [dep, pods] = await Promise.all([
        json(req, '/apis/apps/v1/deployments'),
        json(req, '/api/v1/pods'),
      ]);
      const stats = await nodeMetrics().catch(() => ({ top: [] }));
      const byPod = new Map(stats.top.map((r) => [r.pod, r]));

      const allNs = [...new Set([...dep.items, ...pods.items].map((x) => x.metadata.namespace))];
      const user = detectUserSuffix(allNs);
      const isMine = (ns) => {
        if (!user) return false;
        return ns === `user-space-${user}` || ns === `user-system-${user}` || ns.endsWith(`-${user}`);
      };
      /* 有自己专属命名空间的 = 用户装的；挤在 user-space/user-system 里的 = 系统组件 */
      const roleOf = (ns) => (ns === `user-space-${user}` || ns === `user-system-${user}` ? 'system' : 'app');

      const out = dep.items.filter((d) => isMine(d.metadata.namespace)).map((d) => {
        const ns = d.metadata.namespace;
        const name = d.metadata.name;
        const want = d.spec.replicas ?? 0;
        const ready = d.status.readyReplicas ?? 0;
        const minePods = pods.items.filter((p) => p.metadata.namespace === ns && podBelongsTo(p, name));
        const restarts = minePods.reduce((n, p) => n + (p.status.containerStatuses || []).reduce((a, c) => a + (c.restartCount || 0), 0), 0);
        const memMB = minePods.reduce((n, p) => n + (byPod.get(p.metadata.name)?.memMB || 0), 0);
        const cpu = minePods.reduce((n, p) => n + (byPod.get(p.metadata.name)?.cpu || 0), 0);
        const since = minePods.map((p) => p.status.startTime).filter(Boolean).sort()[0];
        return {
          name: shortName(name),
          ns,
          role: roleOf(ns),
          state: want === 0 ? 'stopped' : (ready >= want ? 'running' : ready > 0 ? 'degraded' : 'down'),
          ready: `${ready}/${want}`,
          restarts,
          memMB: memMB || null,
          cpu: cpu ? +cpu.toFixed(3) : null,
          upH: since ? +((Date.now() - new Date(since)) / 3600000).toFixed(1) : null,
          pod: minePods[0]?.metadata.name || null,
        };
      });

      /* 不带 deployment 的 pod（StatefulSet / 裸 pod）也补进来，
         否则 bfl、emergent-auth 这类在「应用列表」里凭空消失。 */
      const covered = new Set(out.map((a) => a.ns + '/' + a.name));
      for (const p of pods.items) {
        if (!isMine(p.metadata.namespace)) continue;
        if (p.metadata.labels?.['app.kubernetes.io/managed-by'] === 'kubesphere') continue;
        const nm = shortName(p.metadata.ownerReferences?.[0]?.name || p.metadata.name);
        if (covered.has(p.metadata.namespace + '/' + nm)) continue;
        if (out.some((a) => a.ns === p.metadata.namespace && podBelongsTo(p, a.name))) continue;
        const st = p.status;
        out.push({
          name: nm,
          ns: p.metadata.namespace,
          role: roleOf(p.metadata.namespace),
          owner: p.metadata.ownerReferences?.[0]?.kind || 'pod',
          state: st.phase === 'Running' ? 'running' : st.phase?.toLowerCase() || 'unknown',
          ready: `${(st.containerStatuses || []).filter((c) => c.ready).length}/${(st.containerStatuses || []).length}`,
          restarts: (st.containerStatuses || []).reduce((a, c) => a + (c.restartCount || 0), 0),
          memMB: byPod.get(p.metadata.name)?.memMB || null,
          cpu: byPod.get(p.metadata.name)?.cpu ? +byPod.get(p.metadata.name).cpu.toFixed(3) : null,
          upH: st.startTime ? +((Date.now() - new Date(st.startTime)) / 3600000).toFixed(1) : null,
          pod: p.metadata.name,
        });
      }

      out.sort((a, b) => (b.memMB || 0) - (a.memMB || 0));
      const shown = includeSystem ? out : out.filter((a) => a.role === 'app');
      return { apps: shown, total: out.length, hiddenSystem: out.length - shown.length };
    });
  }

  /** 日志：先看 pod 有几个容器，挑掉 sidecar。 */
  async function logs(appName, { lines = 40 } = {}) {
    const { apps: list } = await apps({ includeSystem: true });
    const a = list.find((x) => sameName(x.name, appName)) || list.find((x) => sameName(x.pod, appName));
    if (!a) return { error: `没找到应用「${appName}」`, have: list.map((x) => x.name).slice(0, 12) };

    const pod = a.pod || (await findPod(a.ns, a.name));
    if (!pod) return { error: `「${appName}」当前没有在跑的 pod` };

    const detail = await json(req, `/api/v1/namespaces/${a.ns}/pods/${pod}`);
    const names = (detail.spec?.containers || []).map((c) => c.name);
    /* 顺手把 sidecar 过滤掉：linkerd-proxy / istio-proxy 的日志
       会把用户真正想看的应用日志淹掉。 */
    const container = names.find((n) => !/proxy|istio|linkerd|envoy/i.test(n)) || names[0];
    if (!container) return { error: '这个 pod 没有容器信息' };

    const text = await req(`/api/v1/namespaces/${a.ns}/pods/${pod}/log?tailLines=${lines}&container=${encodeURIComponent(container)}`, { timeout: 8000 });
    return {
      app: a.name, pod, container, lines: text.split('\n').filter(Boolean).slice(-lines),
    };
  }

  async function findPod(ns, name) {
    const list = await json(req, `/api/v1/namespaces/${ns}/pods`);
    return list.items.find((p) => podBelongsTo(p, name))?.metadata.name || null;
  }

  /* ── 诊断：回答"它为什么没起来" ──
   *
   * 日志是**结果**，不是原因。ImagePullBackOff 的 pod 根本没有日志，
   * 起不来的原因写在 containerStatus 的 waiting.reason 和 events 里。
   * 所以这个工具把四样东西一起拿出来：状态、容器状态、conditions、最近事件。
   * 只给模型其中一样，它就会开始猜（"可能是内存不足"）—— 那是幻觉，不是诊断。 */
  async function diagnose(appName) {
    const { apps: list } = await apps({ includeSystem: true });
    const a = list.find((x) => sameName(x.name, appName)) || list.find((x) => sameName(x.pod, appName));
    if (!a) return { error: `没找到应用「${appName}」`, have: list.map((x) => x.name).slice(0, 12) };

    const ns = a.ns;
    const podName = a.pod || (await findPod(ns, a.name));
    const out = {
      app: a.name, ns, pod: podName, state: a.state, ready: a.ready,
      restarts: a.restarts, memMB: a.memMB, upH: a.upH,
    };
    if (!podName) {
      out.note = '当前没有 pod —— deployment 可能被缩到 0，或者压根没建起来';
      return out;
    }

    const pod = await json(req, `/api/v1/namespaces/${ns}/pods/${podName}`);
    const st = pod.status || {};
    out.phase = st.phase;
    out.node = pod.spec?.nodeName;
    out.containers = (st.containerStatuses || []).map((c) => {
      const w = c.state?.waiting;
      const t = c.state?.terminated;
      const last = c.lastState?.terminated;
      return {
        name: c.name,
        ready: !!c.ready,
        restarts: c.restartCount || 0,
        /* waiting.reason 就是答案本身：CrashLoopBackOff / ImagePullBackOff /
           ContainerCreating / OOMKilled（后者在 lastState 里） */
        waiting: w ? { reason: w.reason, message: w.message || null } : null,
        terminated: t ? { reason: t.reason, exitCode: t.exitCode, at: t.finishedAt } : null,
        lastTerminated: last ? { reason: last.reason, exitCode: last.exitCode, at: last.finishedAt } : null,
        image: pod.spec?.containers?.find((x) => x.name === c.name)?.image || null,
      };
    });
    out.conditions = (st.conditions || []).map((c) => ({
      type: c.type, status: c.status, reason: c.reason || null, message: (c.message || '').slice(0, 160) || null,
    }));

    /* 事件要按对象查，不能拉全量：一个跑了 42h 的集群有几千条事件。 */
    const ev = await json(req,
      `/api/v1/namespaces/${ns}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${podName}`)}`)
      .catch(() => ({ items: [] }));
    out.events = ev.items
      .map((e) => ({
        at: e.lastTimestamp || e.eventTime || e.metadata.creationTimestamp,
        type: e.type, reason: e.reason, count: e.count || 1,
        message: String(e.message || '').replace(/\s+/g, ' ').slice(0, 200),
      }))
      .sort((x, y) => String(y.at).localeCompare(String(x.at)))
      .slice(0, 10);
    return out;
  }

  /** 重启 = 删掉 pod，让 ReplicaSet 重新拉一个。不用 rollout restart：
   *  那要 patch deployment（多一份写权限），效果在这里是一样的。 */
  async function restart(appName) {
    const { apps: list } = await apps({ includeSystem: true });
    const a = list.find((x) => sameName(x.name, appName)) || list.find((x) => sameName(x.pod, appName));
    if (!a) return { error: `没找到应用「${appName}」` };
    if (a.role === 'system' && !appName) return { error: '这是系统组件，不能从这儿重启' };
    const pods = (await json(req, `/api/v1/namespaces/${a.ns}/pods`)).items
      .filter((p) => podBelongsTo(p, a.name))
      .map((p) => p.metadata.name);
    if (!pods.length) return { error: `「${a.name}」当前没有在跑的 pod，没什么可重启的` };
    for (const p of pods) {
      await req(`/api/v1/namespaces/${a.ns}/pods/${p}`, { method: 'DELETE', timeout: 8000 });
    }
    return { app: a.name, restarted: pods, note: '已删除，控制器会重新拉起一个' };
  }

  return {
    kind: 'k8s',
    info: () => `${creds.how} → ${creds.host}:${creds.port}`,
    nodeMetrics,
    series,
    apps,
    logs,
    diagnose,
    restart,
    /** 自检：三个来源分别能不能用，报错要具体 */
    async health() {
      const out = { k8s: null, prom: null, sample: null };
      try {
        const v = await json(req, '/version');
        out.k8s = `v${v.major}.${v.minor}`;
      } catch (e) { out.k8s = 'ERR ' + e.message; }
      try {
        const m = await scalar(QUERY.mem);
        out.prom = m == null ? 'ERR 空结果' : `ok mem=${m.toFixed(1)}%`;
      } catch (e) { out.prom = 'ERR ' + e.message; }
      try {
        const s = await nodeMetrics();
        out.sample = `cpu=${(s.cpu * 100).toFixed(0)}% mem=${(s.mem * 100).toFixed(0)}% disk=${(s.disk * 100).toFixed(0)}% top=${s.top[0]?.pod || '-'}`;
      } catch (e) { out.sample = 'ERR ' + e.message; }
      return out;
    },
  };
}

/* ── 小工具 ── */

const clamp01 = (v) => (v == null || !Number.isFinite(v) ? null : Math.min(1, Math.max(0, v / 100)));

/* n8n-67f76cd8df-8gzpp → n8n；files-p28fh → files；n8n-bbbigdan → n8n
 *
 * 后缀有三类，形态不同：
 *   ReplicaSet  -<10位hash>-<5位>
 *   DaemonSet/Job -<5~10位，至少含一个数字>
 *   StatefulSet  -<序号>
 * 最后那条要求"至少含一个数字"才能去掉，否则 `-prod` `-beta` 这类真名字会被切掉。 */
function shortName(n) {
  if (!n) return '';
  const s = String(n).replace(/-bbbigdan$/, '');
  return s
    .replace(/-[a-z0-9]{8,10}-[a-z0-9]{4,5}$/, '')
    .replace(/-[0-9]+$/, '')
    .replace(/-[a-z0-9]{4,10}$/, (m) => (/\d/.test(m) ? '' : m));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[-_\s]/g, '');

function sameName(a, b) {
  if (!a || !b) return false;
  return norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}

/* pod 属于某个 deployment：靠 owner 链走两层（pod → ReplicaSet → Deployment）。
   直接比名字前缀会误判（n8n 与 n8n-worker 互为前缀），所以先看 owner 引用，
   再退化到名字前缀。 */
function podBelongsTo(pod, deployName) {
  const owner = pod.metadata.ownerReferences?.[0];
  if (!owner) return sameName(pod.metadata.name, deployName);
  if (owner.kind === 'ReplicaSet') {
    return owner.name.replace(/-[a-z0-9]{8,10}$/, '') === deployName
      || sameName(pod.metadata.name, deployName);
  }
  return owner.name === deployName || sameName(pod.metadata.name, deployName);
}
