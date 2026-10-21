/**
 * "用户的家在哪"只有一处答案。
 *
 * Olares 把 Home 放在宿主机 /olares/rootfs/userspace/pvc-userspace-<id>-<hash>/Home，
 * Pod 把父目录挂成 /userspace。PVC 名字带随机后缀，所以认 `pvc-userspace-` 前缀。
 *
 * 为什么要单独一个文件：fs.mjs / memory.mjs / forge.mjs 三处都要答案，
 * 各写一遍就会出现"记忆落在 A、工具落在 B"这种事 —— 而用户只能在一个地方看见它们。
 * （fs.mjs 里那份是带路径守卫的完整版，还没合成一份；这条注释留着提醒。）
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function resolveHome() {
  const root = process.env.FS_ROOT;
  if (root) {
    try {
      const ents = await fsp.readdir(root, { withFileTypes: true });
      const pvc = ents.find((e) => e.isDirectory() && e.name.startsWith('pvc-userspace-'));
      if (pvc) {
        const home = path.join(root, pvc.name, 'Home');
        await fsp.access(home);
        return home;
      }
    } catch { /* 没挂载就走下面的兜底 */ }
  }
  return '';
}

/** 没挂上用户目录时，落在代码旁边 —— 本地开发/自测跑得起来，正式部署不会走到这。 */
export const localDir = (name) => path.join(HERE, '..', name);
