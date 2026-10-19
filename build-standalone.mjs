/**
 * 生成单文件版：把 three.module.min.js 与 src/main.js 内联进 index.html
 * 产物 particle-sphere-standalone.html 可直接双击（file://）打开。
 *
 * 处理两个坑：
 * 1. three 压缩产物顶层有 const R 等短名，与主代码冲突 → 主代码包进块级作用域 {}
 * 2. 模块 export{...} 不含 THREE 命名空间 → 转换成 const THREE = {Public: Minified, ...}
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const three = readFileSync(join(root, 'vendor/three.module.min.js'), 'utf8');
const main = readFileSync(join(root, 'src/main.js'), 'utf8');

// 1) 去掉 sourcemap 注释；2) 把 export{min as Public,...} 转成 const THREE = {Public: min, ...}
let threeCore = three.replace(/^\s*\/\/# sourceMappingURL=.*$/m, '');
const m = threeCore.match(/export\{([^}]*)\};?\s*$/);
if (!m) {
  console.error('未找到 export 语句，终止');
  process.exit(1);
}
const props = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((e) => {
  const parts = e.split(/\s+as\s+/);
  if (parts.length !== 2) {
    console.error('无法解析导出项:', e);
    process.exit(1);
  }
  return parts[1] + ': ' + parts[0];
});
const threeNS = 'const THREE = {' + props.join(', ') + '};';
threeCore = threeCore.slice(0, m.index) + threeNS + threeCore.slice(m.index + m[0].length);

// 主代码去掉 import，包进块级作用域（避免与 three 顶层短名冲突）
const mainBody = main.replace(/^import \* as THREE from 'three';\s*\n/m, '');
const bundle = threeCore + '\n{\n' + mainBody + '\n}\n';

const IMPORTMAP = '<script type="importmap">{"imports":{"three":"./vendor/three.module.min.js"}}</script>';
const MODULESCRIPT = '<script type="module" src="./src/main.js"></script>';
if (!html.includes(IMPORTMAP) || !html.includes(MODULESCRIPT)) {
  console.error('index.html 脚本标签与预期不符，终止');
  process.exit(1);
}
const out = html
  .split(IMPORTMAP).join('')
  .split(MODULESCRIPT).join('<script type="module">\n' + bundle + '</script>');

writeFileSync(join(root, 'dist/_bundle_check.mjs'), bundle);
writeFileSync(join(root, 'particle-sphere-standalone.html'), out);
console.log('standalone 生成完毕:', (out.length / 1024).toFixed(0), 'KB, 导出项', props.length, '个');
