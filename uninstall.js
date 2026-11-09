// 卸载清理：用户卸载 Twig 并重启 VSCode 后，由 VSCode 运行（package.json 的 vscode:uninstall），不能用 vscode 接口
// 删掉扩展装进各家 AI skills/twig 目录的文件，保留用户自建的 个人偏好.md；目录空了才删目录
const fs = require('fs');
const os = require('os');
const path = require('path');

// 与 extension.js 中的 AI_HOMES 相同
const AI_HOMES = ['.claude', '.codex', '.gemini'];
const installed = fs.readdirSync(path.join(__dirname, 'skill'));   // 扩展装进去的文件

for (const home of AI_HOMES) {
  const dir = path.join(os.homedir(), home, 'skills', 'twig');
  if (!fs.existsSync(dir)) continue;
  if (fs.lstatSync(dir).isSymbolicLink()) continue;                 // 维护者把目录链接到源码仓库时不动
  for (const file of installed) fs.rmSync(path.join(dir, file), { force: true });
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
