// 通过 GitHub REST API 推一个提交。
//
// 为什么需要这个：这台机器到 github.com:443 的 git 通道被掐了（TLS 握手被重置），
// 而 api.github.com 通。API 能做的事够用：建 blob → 建 tree → 建 commit → 挪 ref。
//
// 关键一点：**要让远端生成的 sha 和本地一样**。做法是把 author / committer 的
// 名字、邮箱、时间、message 全部照抄本地提交 —— 树、父提交、元信息一致，
// sha 就一致（sha 是这些字段的哈希）。这样推完本地和远端不分叉，不用再 rebase。
//
// 用法：node tools/dev/push-api.mjs <owner/repo> <baseSha> <headSha>
//   baseSha 取远端当前的 sha：gh api repos/<owner>/<repo>/git/ref/heads/main --jq .object.sha
import { execFileSync } from 'node:child_process';

const [repo, base, head] = process.argv.slice(2);
const TOK = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
}).toString().split('\n').find((l) => l.startsWith('password=')).slice(9);

const git = (...a) => execFileSync('git', a, { maxBuffer: 64 * 1024 * 1024 }).toString();
const api = async (method, path, body) => {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOK}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'emergent-desktop-push',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

// 1. 变更清单（含删除）
const changes = git('diff', '--name-status', base, head)
  .trim().split('\n').filter(Boolean)
  .map((l) => { const [st, ...p] = l.split('\t'); return { st, path: p.join('\t') }; });

// 2. 逐个建 blob
const entries = [];
for (const { st, path } of changes) {
  if (st === 'D') {
    // 删除：sha 给 null，GitHub 就把它从树里摘掉
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
    continue;
  }
  const mode = git('ls-tree', head, '--', path).split(' ')[0];
  const content = execFileSync('git', ['cat-file', 'blob', `${head}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  const { sha } = await api('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
  entries.push({ path, mode, type: 'blob', sha });
  console.log(`  blob ${st} ${path} (${mode}) ${sha.slice(0, 7)}`);
}

// 3. 建 tree（base_tree 只带变更，其余原样继承）
const tree = await api('POST', '/git/trees', { base_tree: base, tree: entries });

// 4. 建 commit —— 元信息照抄本地，sha 才能对上
const meta = git('log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', head).trim().split('\0');
const message = git('cat-file', 'commit', head).split('\n\n').slice(1).join('\n\n');
const commit = await api('POST', '/git/commits', {
  message,
  tree: tree.sha,
  parents: [base],
  author: { name: meta[0], email: meta[1], date: meta[2] },
  committer: { name: meta[3], email: meta[4], date: meta[5] },
});

// 5. 挪 ref（不快进就报错，这里要的就是这个：分叉了宁可失败）
await api('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false });

console.log(`remote commit ${commit.sha}`);
console.log(`local  commit ${head}`);
console.log(commit.sha === head ? '✅ 一致（本地与远端不分叉）' : '⚠️ 不一致：需要 git fetch 后核对');
