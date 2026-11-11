#!/usr/bin/env node
/**
 * 提交前 / CI 防泄露扫描。
 * 检测：硬编码 32 字节 base64 密钥、常见 token 前缀、私钥头、中国大陆手机号。
 * 命中时只打印「文件:行号 + 规则名」，不回显匹配内容，避免二次泄露。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);
const TEXT_EXT = new Set([".mjs", ".js", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".sh", ".plist", ".html", ".htm", ".css", ".example", ""]);

const RULES = [
  { name: "base64-32byte-key", re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/])/ },
  { name: "token-prefix", re: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|apikey_[A-Za-z0-9_]{20,})/ },
  { name: "private-key-pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "cn-mobile-number", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: "hardcoded-secret-assignment", re: /(?:FALLBACK_SECRET|atRestSecretKey|accessToken)\s*[:=]\s*["'][A-Za-z0-9+/]{20,}["']/ },
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(ROOT, path.join(dir, ent.name));
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out);
      continue;
    }
    if (ent.name.startsWith(".") && ent.name !== ".gitignore") continue;
    if (rel === SELF || ent.name.endsWith(".lock") || ent.name.endsWith(".bak")) continue;
    if (!TEXT_EXT.has(path.extname(ent.name))) continue;
    out.push(rel);
  }
  return out;
}

const hits = [];
for (const rel of walk(ROOT)) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) if (rule.re.test(line)) hits.push(`${rel}:${i + 1}  [${rule.name}]`);
  });
}

if (hits.length) {
  process.stderr.write("❌ 疑似敏感信息，禁止提交：\n" + hits.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`✅ 防泄露扫描通过（${walk(ROOT).length} 个文本文件，${RULES.length} 条规则）\n`);
}
