// 把插件打包成 Magpie 需要的形态：只拷贝运行时必需的文件，
// 产出 dist/magpie-autoswitch/ 目录（可直接 `magpie plugin add ./dist/magpie-autoswitch`）
// 以及一份 dist/magpie-autoswitch-<version>.tgz（用于分发/发布）。
//
// 运行时必需：index.mjs、src/（含 console/ 分片）、package.json、icon.png、README.md、RELEASE_NOTES.md、LICENSE。
// 不需要打进包：test/、node_modules/、lock 文件、日志、.gitignore、.DS_Store 等。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const pkg = readJSON(path.join(root, "package.json"));
const version = String(pkg.version || "0.0.0");

// 运行时必需的文件 / 目录（相对项目根）
const INCLUDE = ["index.mjs", "src", "icon.png", "README.md", "RELEASE_NOTES.md", "LICENSE"];

const OUT_DIR = path.join(root, "dist");
const BUNDLE = path.join(OUT_DIR, "magpie-autoswitch");
const TGZ = path.join(OUT_DIR, `magpie-autoswitch-${version}.tgz`);

// 清掉旧的 dist
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(BUNDLE, { recursive: true });

// 拷贝普通条目
for (const rel of INCLUDE) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    console.warn(`[pack] 跳过（不存在）：${rel}`);
    continue;
  }
  const dest = path.join(BUNDLE, rel);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 拷贝一份精简的 package.json（去掉 test / files 等指向打包外资源的元数据）
const bundledPkg = { ...pkg };
delete bundledPkg.files;
delete bundledPkg.scripts;
if (!Array.isArray(bundledPkg.keywords)) delete bundledPkg.keywords;
fs.writeFileSync(
  path.join(BUNDLE, "package.json"),
  `${JSON.stringify(bundledPkg, null, 2)}\n`,
);

// 生成 tar.gz（macOS / Linux 自带 tar；Windows 用户可用目录形式安装）
try {
  execFileSync("tar", ["-czf", TGZ, "-C", OUT_DIR, "magpie-free-switch"], {
    stdio: "inherit",
  });
} catch (err) {
  console.warn("[pack] 无法生成 .tgz（可忽略，目录包仍可用）：", err.message);
}

// 统计体积
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`[pack] 目录包 -> ${path.relative(root, BUNDLE)}  (${kb(dirSize(BUNDLE))})`);
if (fs.existsSync(TGZ)) {
  console.log(`[pack] 压缩包 -> ${path.relative(root, TGZ)}  (${kb(fs.statSync(TGZ).size)})`);
}
console.log("[pack] 完成。安装：magpie plugin add ./dist/magpie-free-switch");
