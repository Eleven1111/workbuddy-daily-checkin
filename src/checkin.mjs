#!/usr/bin/env node
/**
 * WorkBuddy「Buddy 加油站」每日签到 — v1.1.0
 *
 * 零依赖 · 单文件 · 可在任意 Node >= 18 下直接运行（不需要打开客户端界面）。
 *
 * 原理（只读取本机自己的登录态，调用官方签到接口）：
 *   1. 登录态文件里的敏感字段被包装成 {"$wbEncrypted":1,"envelope":"<base64>"}。
 *   2. envelope 是 suite=1 的 AES-256-GCM 密文；解封密钥 = sha256(utf8(atRestSecretKey))。
 *   3. atRestSecretKey 由客户端原生模块在运行时提供。脚本按
 *      「同进程 binding → Electron 子进程 → 用户自备文件/环境变量」顺序取钥，
 *      仓库里不含任何编译期常量或真实凭据。
 *   4. 解出明文 accessToken，仅在内存中使用，不落盘、不打印。
 *
 * 用法：
 *   node src/checkin.mjs                        # 查询 + 领取
 *   node src/checkin.mjs --check-only --json   # 只查询
 *   node src/checkin.mjs --if-needed --quiet  # 当天已成功则跳过（配合多次定时触发）
 *   node src/checkin.mjs --doctor             # 本地自检，不联网
 *   node src/checkin.mjs --history=30         # 近 30 天签到台账 / 漏签检测
 *   node src/checkin.mjs --redact-history     # 清洗 v1.0.0 遗留日志里的个人信息
 *
 * 详细文档见 README.md。仅用于本人设备、本人账号的日常签到。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "1.1.0";

const HOME = os.homedir();
const STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const CLAIM_PATH = "/v2/billing/meter/daily-checkin";
const LOCK_STALE_MS = 10 * 60 * 1000;

/** 允许写入磁盘日志的字段白名单。任何新增字段默认都不落盘。 */
export const LOG_WHITELIST = Object.freeze([
  "ts", "started", "finished", "duration_ms", "version",
  "ok", "claimed", "skipped", "reason", "conclusion",
  "gained", "streak_days", "total_credits",
  "statusHttp", "claimHttp", "keySource", "keyblobCheck", "domain",
  "retriesUsed", "dryRun",
]);

// ─────────────────────────── 配置 ───────────────────────────

const env = (name, fallback) => (process.env[name] && process.env[name].trim()) || fallback;
const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function loadConfig(overrides = {}) {
  const cfg = {
    electronBin: env("WB_ELECTRON_BIN", "/Applications/WorkBuddy.app/Contents/MacOS/Electron"),
    authFile: env("WB_AUTH_FILE", path.join(HOME, "Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info")),
    keyblobFile: env("WB_KEYBLOB_FILE", path.join(HOME, ".workbuddy/keyblob")),
    logFile: env("WB_LOG_FILE", path.join(HOME, ".workbuddy/logs/daily-checkin.log")),
    lockFile: env("WB_LOCK_FILE", path.join(HOME, ".workbuddy/logs/daily-checkin.lock")),
    secretFile: env("WB_SECRET_FILE", path.join(HOME, ".config/workbuddy-checkin/atrest-secret")),
    apiBase: env("WB_API_BASE", ""),
    timeoutMs: intEnv("WB_TIMEOUT_MS", 20000),
    retries: Math.min(intEnv("WB_RETRIES", 2), 5),
  };
  return { ...cfg, ...overrides };
}

// ─────────────────────────── CLI ───────────────────────────

export function parseArgs(argv = []) {
  const has = (f) => argv.includes(f);
  const valueOf = (prefix) => {
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const days = Number.parseInt(valueOf("--history=") ?? "", 10);
  return {
    checkOnly: has("--check-only"),
    json: has("--json"),
    quiet: has("--quiet") || has("-q"),
    ifNeeded: has("--if-needed"),
    force: has("--force"),
    doctor: has("--doctor"),
    history: has("--history") || valueOf("--history=") !== null,
    historyDays: Number.isFinite(days) && days > 0 ? days : 30,
    redactHistory: has("--redact-history"),
    verbose: has("--verbose"),
    noLog: has("--no-log"),
    version: has("--version") || has("-V"),
    help: has("--help") || has("-h"),
  };
}

export const HELP_TEXT = `WorkBuddy 加油站每日签到 v${VERSION}

用法: node src/checkin.mjs [选项]

签到:
  (无参数)            查询状态，未签到则领取，然后复查
  --check-only        只查询，不领取
  --if-needed         当天已有成功记录则直接跳过，不请求接口
  --force             忽略 --if-needed 的跳过判断

本地维护:
  --doctor            自检本机环境（不联网）
  --history[=N]       输出近 N 天台账与漏签检测（默认 30）
  --redact-history    清洗 v1.0.0 遗留日志中的个人信息（自动备份）

输出:
  --json              机器可读 JSON（自动化任务推荐）
  --quiet             只输出一行结论
  --verbose           输出调试细节（含令牌有效期等，不会写入日志）
  --no-log            本次不写日志
  --version / --help

退出码: 0 = 成功/已签到/已跳过；1 = 失败；2 = 参数错误。

环境变量（均有默认值，通常无需设置）:
  WB_ELECTRON_BIN  WB_AUTH_FILE  WB_KEYBLOB_FILE  WB_LOG_FILE  WB_LOCK_FILE
  WB_SECRET_FILE   WB_API_BASE   WB_TIMEOUT_MS    WB_RETRIES   WB_ATREST_SECRET_B64
`;

// ─────────────────────── at-rest 解密 ───────────────────────
// 与客户端 suite=1 字段级封装格式对齐。只实现「解开自己机器上的字段」。

const AAD_PREFIX = Buffer.from("WB-AAD\0", "ascii");
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const FRAMING_MAGIC = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };

const u32be = (v) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v);
  return b;
};
const lenPrefixed = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32be(b.length), b]);
};
const optUint64 = (v) => {
  if (v === undefined) return Buffer.from([0]);
  const b = Buffer.allocUnsafe(9);
  b[0] = 1;
  b.writeBigUInt64BE(v, 1);
  return b;
};

export function buildAuthenticatedContextAad(keyId, suite, ctx, scheme = "sym-v1") {
  if (scheme !== "sym-v1") throw new Error("only sym-v1 is supported");
  if (!ctx || !FRAMING_MAGIC[ctx.framing]) throw new Error("bad framing: " + String(ctx && ctx.framing));
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lenPrefixed(FRAMING_MAGIC[ctx.framing]),
    lenPrefixed(scheme),
    u32be(suite),
    lenPrefixed(keyId),
    Buffer.from([FRAMING_CODE[ctx.framing]]),
    optUint64(ctx.sequence),
    Buffer.from([ctx.final === undefined ? 0 : ctx.final ? 2 : 1]),
  ]);
}

export const deriveAtRestKeyId = (keyBytes) =>
  crypto.createHash("sha256").update(keyBytes).digest("hex").slice(0, 16);

/** 测试 / 通用封装：由 key + 明文生成 envelope（返回 JSON 对象） */
export function sealEnvelope(key, plaintext, ctx = { framing: "field" }) {
  const keyId = deriveAtRestKeyId(key);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAuthenticatedContextAad(keyId, 1, ctx, "sym-v1"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** AES-256-GCM 解封 */
export function openEnvelope(key, env, ctx = { framing: "field" }) {
  if (env.keyId !== deriveAtRestKeyId(key)) throw new Error("keyId 不匹配（客户端密钥可能已变更）");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", key, Buffer.from(env.nonce, "base64"), { authTagLength: 16 }
  );
  decipher.setAAD(buildAuthenticatedContextAad(env.keyId, env.suite, ctx, "sym-v1"));
  decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, "base64")),
    decipher.final(),
  ]);
}

export function parseEnvelopeFromWrapper(wrapper) {
  if (!wrapper || typeof wrapper !== "object" || wrapper.$wbEncrypted !== 1) {
    throw new Error("字段不是 $wbEncrypted 包装（可能客户端已改回明文）");
  }
  if (typeof wrapper.envelope !== "string") throw new Error("字段缺少 envelope");
  const env = JSON.parse(Buffer.from(wrapper.envelope, "base64").toString("utf8"));
  if (!Number.isInteger(env.suite) || typeof env.keyId !== "string") {
    throw new Error("envelope 结构不符 suite=1 规范");
  }
  return env;
}

export function decryptField(key, wrapper) {
  return openEnvelope(key, parseEnvelopeFromWrapper(wrapper), { framing: "field" }).toString("utf8");
}

// ─────────────────────── 取密钥 / 取登录态 ───────────────────────

/** 在 Electron 子进程里取 atRestSecretKey；不读取除运行时 API 之外的任何东西。 */
function nativeKeyViaSubprocess(electronBin) {
  if (!fs.existsSync(electronBin)) return null;
  const src =
    'try{const b=process._linkedBinding("electron_browser_workbuddy_storage");' +
    'const p=JSON.parse(b.loggerGet());process.stdout.write(p.atRestSecretKey||"")}catch(e){process.exit(3)}';
  try {
    const r = spawnSync(electronBin, ["-e", src], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    const out = (r.stdout || "").trim();
    if (/^[A-Za-z0-9+/]{43}=$/.test(out)) return out;
  } catch {
    /* ignore */
  }
  return null;
}

/** 用户自备密钥（可选）。优先级：环境变量 > 0600 配置文件。 */
function userSuppliedSecret(cfg) {
  const fromEnv = (process.env.WB_ATREST_SECRET_B64 || "").trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(fromEnv)) return { secretB64: fromEnv, source: "env" };
  try {
    const fromFile = fs.readFileSync(cfg.secretFile, "utf8").trim();
    if (/^[A-Za-z0-9+/]{43}=$/.test(fromFile)) return { secretB64: fromFile, source: "secret-file" };
  } catch {
    /* ignore */
  }
  return null;
}

export function loadProtectorKey(cfg) {
  let secretB64 = null;
  let source = null;

  // 1) 同进程 native binding（由客户端自带 Electron 以 Node 模式运行时命中）
  try {
    if (typeof process._linkedBinding === "function") {
      const binding = process._linkedBinding("electron_browser_workbuddy_storage");
      if (binding && typeof binding.loggerGet === "function") {
        const payload = JSON.parse(binding.loggerGet());
        if (typeof payload.atRestSecretKey === "string") {
          secretB64 = payload.atRestSecretKey;
          source = "native-loggerGet";
        }
      }
    }
  } catch {
    /* 非 Electron 运行时，走下一步 */
  }

  // 2) Electron 子进程（客户端升级后自愈，最常用路径）
  if (!secretB64) {
    const v = nativeKeyViaSubprocess(cfg.electronBin);
    if (v) {
      secretB64 = v;
      source = "electron-subprocess";
    }
  }

  // 3) 用户自备（离线 / 无 GUI 环境）
  if (!secretB64) {
    const v = userSuppliedSecret(cfg);
    if (v) {
      secretB64 = v.secretB64;
      source = v.source;
    }
  }

  // 4) 明确失败，绝不在仓库里内置任何编译期常量
  if (!secretB64) {
    throw new Error(
      "无法取得 at-rest 密钥：请确认 WorkBuddy 桌面端已安装并登录，或设置 WB_ATREST_SECRET_B64 / " + cfg.secretFile
    );
  }

  const key = crypto.createHash("sha256").update(secretB64, "utf8").digest();
  return { key, keyId: deriveAtRestKeyId(key), source };
}

export function readAuthState(cfg) {
  if (!fs.existsSync(cfg.authFile)) throw new Error("找不到登录态文件：" + cfg.authFile);
  return JSON.parse(fs.readFileSync(cfg.authFile, "utf8"));
}

/** keyblob 自检：只用 file framing 验证派生链，结果不含任何密钥材料。 */
export function selfCheckKeyblob(key, cfg) {
  try {
    if (!fs.existsSync(cfg.keyblobFile)) return "skip(no-keyblob)";
    const kb = JSON.parse(fs.readFileSync(cfg.keyblobFile, "utf8"));
    const slot = (kb.slots || []).find((s) => s.type === "static-v1");
    if (!slot) return "skip(no-static-v1)";
    if (slot.protectorKeyId && slot.protectorKeyId !== deriveAtRestKeyId(key)) return "MISMATCH(protectorKeyId)";
    const env = JSON.parse(Buffer.from(slot.wrapped, "base64").toString("utf8"));
    const masterKey = openEnvelope(key, env, { framing: "file" });
    const ok = deriveAtRestKeyId(masterKey) === kb.keyId;
    masterKey.fill(0);
    return ok ? "ok" : "MISMATCH(masterKeyId)";
  } catch {
    return "error(check-failed)";
  }
}

// ─────────────────────────── HTTP ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apiCall(base, p, token, method, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(base + p, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "WorkBuddy-Daily-Checkin/" + VERSION,
      },
      body: method === "POST" ? "{}" : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带退避重试。
 * - 网络异常 / 超时：可重试（服务端有重复领取幂等保护）
 * - 5xx / 429：仅查询接口重试；领取接口不重试，避免响应丢失导致二次提交
 */
export async function apiCallWithRetry(base, p, token, method, cfg, { retryOn5xx = true } = {}) {
  let retriesUsed = 0;
  for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
    let res;
    try {
      res = await apiCall(base, p, token, method, cfg);
    } catch (e) {
      if (attempt < cfg.retries) {
        retriesUsed += 1;
        await sleep(400 * 2 ** attempt);
        continue;
      }
      e.retriesUsed = retriesUsed;
      throw e;
    }
    const transient = (res.status >= 500 || res.status === 429) && retryOn5xx;
    if (transient && attempt < cfg.retries) {
      retriesUsed += 1;
      await sleep(400 * 2 ** attempt);
      continue;
    }
    res.retriesUsed = retriesUsed;
    return res;
  }
  throw new Error("unreachable");
}

export const pickData = (body) => (body && typeof body.data === "object" && body.data) || body || {};
export const normalizeCode = (v) => (v === undefined || v === null ? null : String(v));
export const isClaimSuccess = (body) => normalizeCode(body?.code) === "0";
export const isAlreadyClaimed = (body) => ["10001", "10002"].includes(normalizeCode(body?.code));

/** 优先用「复查累计积分 - 复查前累计积分」算真实到账，其次才用响应字段。 */
export function computeGained({ claimedOk, before, after, claimData }) {
  if (!claimedOk) return 0;
  const c = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const b = c(before?.total_credits);
  const a = c(after?.total_credits);
  if (b !== null && a !== null && a > b) return a - b;
  for (const v of [claimData?.credit, claimData?.today_credit, after?.today_credit, before?.daily_credit]) {
    const n = c(v);
    if (n !== null && n > 0) return n;
  }
  return 0;
}

// ─────────────────────────── 台账 / 日志 ───────────────────────────

export function localDateKey(v = Date.now()) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readLedger(cfg) {
  try {
    return fs.readFileSync(cfg.logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 当天已有成功领取记录 → 可跳过，避免多次定时触发重复打接口。 */
export function isAlreadyDoneToday(rows, today = localDateKey()) {
  return rows.some((r) =>
    localDateKey(r.ts || r.started) === today &&
    r.ok === true &&
    !r.skipped &&
    r.dryRun !== true &&
    (r.claimed === true || r.reason === "already")
  );
}

export function sanitizeForLog(payload) {
  const safe = {};
  for (const k of LOG_WHITELIST) if (payload[k] !== undefined) safe[k] = payload[k];
  if (!safe.ts) safe.ts = payload.started || new Date().toISOString();
  return safe;
}

export function writeLog(payload, cfg) {
  try {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    fs.appendFileSync(cfg.logFile, JSON.stringify(sanitizeForLog(payload)) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ─────────────────────────── 并发锁 ───────────────────────────

export function acquireLock(cfg) {
  try {
    fs.mkdirSync(path.dirname(cfg.lockFile), { recursive: true });
    const fd = fs.openSync(cfg.lockFile, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") return true; // 无权限创建锁时放行，不阻塞签到
    try {
      if (Date.now() - fs.statSync(cfg.lockFile).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(cfg.lockFile);
        return acquireLock(cfg);
      }
    } catch {
      /* 锁仍在，交给下一次触发 */
    }
    return false;
  }
}

export function releaseLock(cfg) {
  try { fs.unlinkSync(cfg.lockFile); } catch { /* ignore */ }
}

// ─────────────────────────── 输出 ───────────────────────────

export function output(payload, code, opt) {
  if (opt.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (opt.quiet) {
    process.stdout.write(String(payload.conclusion) + "\n");
  } else {
    for (const line of payload.lines || [payload.conclusion]) process.stdout.write(String(line) + "\n");
  }
  process.exitCode = code;
  return payload;
}

const finish = (payload, code, opt, cfg, lines) => {
  const full = { ...payload, lines: lines || [payload.conclusion], version: VERSION };
  if (!opt.noLog && !full.skipped) writeLog(full, cfg);
  return output(full, code, opt);
};

// ─────────────────────────── 子命令 ───────────────────────────

function cmdDoctor(cfg, opt) {
  const started = new Date().toISOString();
  const lines = [];
  const checks = {
    electronBin: fs.existsSync(cfg.electronBin),
    authFile: fs.existsSync(cfg.authFile),
    keyblobFile: fs.existsSync(cfg.keyblobFile),
    logFile: fs.existsSync(cfg.logFile),
  };
  let keySource = null;
  let keyblobCheck = "skip";
  let tokenDecryptable = false;
  let tokenExpiresAt = null;
  let error = null;
  try {
    const { key, source } = loadProtectorKey(cfg);
    keySource = source;
    keyblobCheck = selfCheckKeyblob(key, cfg);
    const state = readAuthState(cfg);
    const auth = state.auth || {};
    decryptField(key, auth.accessToken); // 只验证可解，不保留明文
    tokenDecryptable = true;
    tokenExpiresAt = Number(auth.expiresAt) ? new Date(Number(auth.expiresAt)).toISOString() : null;
  } catch (e) {
    error = e.message;
  }
  const ok = checks.authFile && tokenDecryptable && keyblobCheck !== "error(check-failed)";
  lines.push(`● Electron=${checks.electronBin ? "ok" : "缺失"} 登录态=${checks.authFile ? "ok" : "缺失"} keyblob=${checks.keyblobFile ? "ok" : "缺失"}`);
  lines.push(`● 密钥来源=${keySource || "未取得"} 自检=${keyblobCheck} 令牌可解密=${tokenDecryptable}`);
  if (opt.verbose && tokenExpiresAt) lines.push(`● 令牌有效期至=${tokenExpiresAt}`);
  const conclusion = ok
    ? "✅ 本机环境自检通过（未联网）"
    : `❌ 自检未通过：${error || "环境不完整"}`;
  lines.push("→ " + conclusion);
  const payload = { ok, conclusion, started, version: VERSION, checks, keySource, keyblobCheck, tokenDecryptable, error };
  if (opt.verbose) payload.tokenExpiresAt = tokenExpiresAt;
  if (opt.json) return output(payload, ok ? 0 : 1, opt);
  return output({ ...payload, lines }, ok ? 0 : 1, opt);
}

function cmdHistory(cfg, opt) {
  const started = new Date().toISOString();
  const rows = readLedger(cfg);
  if (!rows.length) {
    const conclusion = "ℹ 暂无签到台账记录";
    return output({ ok: true, conclusion, started, total: 0, rows: [], lines: [conclusion] }, 0, opt);
  }
  const byDay = new Map();
  for (const r of rows) {
    const d = localDateKey(r.ts || r.started);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const sortedDays = [...byDay.keys()].sort();
  const first = sortedDays[0];
  const today = localDateKey();
  const allDays = [];
  for (let d = new Date(first + "T00:00:00"); localDateKey(d) <= today && allDays.length < 730; d.setDate(d.getDate() + 1)) {
    allDays.push(localDateKey(d));
  }
  const missed = allDays.filter((d) => {
    const recs = byDay.get(d) || [];
    return !recs.some((r) => r.ok === true && !r.skipped && r.dryRun !== true && (r.claimed === true || r.reason === "already"));
  });
  const claimed = rows.filter((r) => r.claimed === true).length;
  const failed = rows.filter((r) => r.ok === false).length;
  const gained = rows.reduce((s, r) => s + (Number(r.gained) || 0), 0);
  const last = rows[rows.length - 1];
  const window = allDays.slice(-opt.historyDays);
  const table = window.map((d) => {
    const recs = byDay.get(d) || [];
    const good = recs.find((r) => r.claimed === true);
    const already = recs.find((r) => r.reason === "already");
    const bad = recs.find((r) => r.ok === false);
    return {
      date: d,
      state: good ? "claimed" : already ? "already" : bad ? "failed" : recs.length ? "check-only" : "missed",
      gained: good?.gained ?? 0,
      streak_days: good?.streak_days ?? already?.streak_days ?? null,
      total_credits: good?.total_credits ?? already?.total_credits ?? last?.total_credits ?? null,
    };
  });
  const conclusion = `📅 台账 ${rows.length} 条 / ${allDays.length} 天：领取 ${claimed} 次，失败 ${failed} 次，累计获得 ${gained} 积分，疑似漏签 ${missed.length} 天`;
  const lines = [conclusion];
  for (const t of table.slice(-14)) {
    lines.push(`  ${t.date}  ${t.state.padEnd(10)} +${String(t.gained).padStart(4)}  连签=${t.streak_days ?? "-"}  累计=${t.total_credits ?? "-"}`);
  }
  if (missed.length) lines.push(`  ⚠ 疑似漏签日期：${missed.slice(-10).join(", ")}${missed.length > 10 ? " …" : ""}`);
  const payload = { ok: true, conclusion, started, version: VERSION, total: rows.length, days: allDays.length, claimed, failed, gained, missed, latest: last, table };
  if (opt.json) return output(payload, 0, opt);
  return output({ ...payload, lines }, 0, opt);
}

function cmdRedactHistory(cfg, opt) {
  const started = new Date().toISOString();
  const rows = readLedger(cfg);
  if (!rows.length) {
    const conclusion = "ℹ 没有需要清洗的台账";
    return output({ ok: true, conclusion, started, changed: 0, lines: [conclusion] }, 0, opt);
  }
  const backup = cfg.logFile + ".v1.0.0.bak";
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(cfg.logFile, backup);
    const tmp = cfg.logFile + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(sanitizeForLog(r))).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cfg.logFile);
  } catch (e) {
    const conclusion = "❌ 清洗失败：" + e.message;
    return output({ ok: false, conclusion, started, lines: [conclusion] }, 1, opt);
  }
  const dropped = rows.reduce((n, r) => n + Object.keys(r).filter((k) => !LOG_WHITELIST.includes(k)).length, 0);
  const conclusion = `✅ 已清洗 ${rows.length} 条记录、移除 ${dropped} 个非白名单字段；原文件备份于 ${backup}`;
  return output({ ok: true, conclusion, started, changed: rows.length, dropped, backup, lines: [conclusion] }, 0, opt);
}

// ─────────────────────────── 主流程 ───────────────────────────

async function runCheckin(cfg, opt) {
  const startedAt = Date.now();
  const started = new Date(startedAt).toISOString();
  const lines = [];
  const detail = {};
  let retriesUsed = 0;

  const basePayload = () => ({
    started,
    finished: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    gained: 0,
    streak_days: null,
    total_credits: null,
    retriesUsed,
    ...detail,
  });

  // 0) 幂等跳过（按本机本地日期判断，避免多次定时触发重复请求）
  if (opt.ifNeeded && !opt.force) {
    const rows = readLedger(cfg);
    if (isAlreadyDoneToday(rows)) {
      const last = [...rows].reverse().find((r) => r.total_credits !== undefined) || {};
      const conclusion = `⏭ 今日已签到，跳过本次请求（连签 ${last.streak_days ?? "-"} 天，累计 ${last.total_credits ?? "-"} 积分）`;
      const payload = {
        ...basePayload(),
        ok: true, claimed: false, skipped: true, reason: "already_done_today", conclusion,
        streak_days: last.streak_days ?? null, total_credits: last.total_credits ?? null,
      };
      return output({ ...payload, lines: [...lines, "→ " + conclusion] }, 0, opt);
    }
  }

  // 1) 密钥
  let keyMaterial;
  try {
    keyMaterial = loadProtectorKey(cfg);
  } catch (e) {
    const payload = { ok: false, reason: "missing_atrest_key", conclusion: "❌ " + e.message, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ " + payload.conclusion]);
  }
  const { key, source } = keyMaterial;
  detail.keySource = source;
  detail.keyblobCheck = selfCheckKeyblob(key, cfg);
  if (opt.verbose) detail.keyId = keyMaterial.keyId;
  lines.push(`● 密钥来源=${source} 自检=${detail.keyblobCheck}`);
  if (String(detail.keyblobCheck).startsWith("MISMATCH") || String(detail.keyblobCheck).startsWith("error")) {
    lines.push("  ⚠ 密钥自检未通过，请先在 WorkBuddy 客户端登录一次并确认版本未变更。");
  }

  // 2) 登录态（明文 token 只留在内存）
  let state;
  try {
    state = readAuthState(cfg);
  } catch (e) {
    const payload = { ok: false, reason: "auth_unreadable", conclusion: "❌ " + e.message, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ " + payload.conclusion]);
  }
  const auth = state.auth || {};
  const domain = auth.domain || "www.codebuddy.cn";
  const base = cfg.apiBase || "https://" + domain;
  detail.domain = domain;

  let accessToken;
  try {
    accessToken = decryptField(key, auth.accessToken);
  } catch (e) {
    const payload = { ok: false, reason: "token_undecryptable", conclusion: "❌ 无法解出登录令牌：" + e.message, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ " + payload.conclusion]);
  }
  if (opt.verbose) {
    detail.tokenLength = accessToken.length;
    detail.tokenExpiresAt = Number(auth.expiresAt) ? new Date(Number(auth.expiresAt)).toISOString() : "unknown";
    lines.push(`● 域=${domain} 令牌长度=${accessToken.length} 有效期至=${detail.tokenExpiresAt}`);
  }
  const expMs = Number(auth.expiresAt) || 0;
  if (expMs > 0 && expMs < Date.now() + 30_000) {
    const conclusion = "❌ 登录态已过期，请打开 WorkBuddy 重新登录后再试";
    const payload = { ok: false, reason: "token_expired", conclusion, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ 脚本不会尝试刷新登录态（交由客户端处理）。"]);
  }

  // 3) 查询状态
  let st;
  try {
    st = await apiCallWithRetry(base, STATUS_PATH, accessToken, "POST", cfg);
  } catch (e) {
    retriesUsed = e.retriesUsed || 0;
    const payload = { ok: false, reason: "network", conclusion: "❌ 网络错误：" + e.message, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ 网络错误：" + e.message]);
  }
  retriesUsed += st.retriesUsed || 0;
  detail.statusHttp = st.status;
  const sd = pickData(st.body);
  detail.before = {
    today_checked_in: sd.today_checked_in,
    streak_days: sd.streak_days,
    total_credits: sd.total_credits,
    daily_credit: sd.daily_credit,
    theme_name: sd.theme_name,
  };

  if (st.status === 401 || st.status === 403 || normalizeCode(sd.code) === "401") {
    const conclusion = "❌ 登录态被拒（401/403），请重新登录 WorkBuddy";
    const payload = { ok: false, reason: "unauthorized", conclusion, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ " + conclusion]);
  }
  if (st.status !== 200 || sd.active === false) {
    const conclusion = `⚠ 加油站活动未开启或无数据（HTTP ${st.status}）`;
    const payload = { ok: false, reason: "activity_inactive", conclusion, ...basePayload() };
    if (opt.verbose) payload.raw = st.body;
    return finish(payload, 1, opt, cfg, [...lines, "⚠ " + conclusion]);
  }

  lines.push(`● 当前状态 今日已签=${sd.today_checked_in} 连签=${sd.streak_days}天 累计=${sd.total_credits} 日积分=${sd.daily_credit} 活动=${sd.theme_name || "-"}`);

  const summary = {
    gained: 0,
    streak_days: sd.streak_days ?? null,
    total_credits: sd.total_credits ?? null,
  };

  // 4) 已签 / 仅查询
  if (sd.today_checked_in === true) {
    const conclusion = `✅ 今日已签到（连签 ${summary.streak_days} 天，累计 ${summary.total_credits} 积分）`;
    const payload = { ok: true, claimed: false, reason: "already", conclusion, ...basePayload(), ...summary };
    return finish(payload, 0, opt, cfg, [...lines, "→ " + conclusion]);
  }
  if (opt.checkOnly) {
    const conclusion = `ℹ 今日未签到（连签 ${summary.streak_days} 天，累计 ${summary.total_credits} 积分）`;
    const payload = { ok: true, claimed: false, reason: "check-only", conclusion, ...basePayload(), ...summary };
    return finish(payload, 0, opt, cfg, [...lines, "→ " + conclusion]);
  }

  // 5) 领取（领取接口不重试 5xx，避免响应丢失后的二次提交）
  let cl;
  try {
    cl = await apiCallWithRetry(base, CLAIM_PATH, accessToken, "POST", cfg, { retryOn5xx: false });
  } catch (e) {
    retriesUsed += e.retriesUsed || 0;
    const payload = { ok: false, reason: "network", conclusion: "❌ 领取请求网络错误：" + e.message, ...basePayload() };
    return finish(payload, 1, opt, cfg, [...lines, "✗ 领取请求网络错误：" + e.message]);
  }
  retriesUsed += cl.retriesUsed || 0;
  detail.claimHttp = cl.status;
  const cd = pickData(cl.body);
  const claimedOk = cl.status === 200 && isClaimSuccess(cl.body);
  const alreadyCode = isAlreadyClaimed(cl.body);
  if (opt.verbose) detail.claimBody = cl.body;

  // 6) 复查
  let after = null;
  try {
    const s2 = await apiCallWithRetry(base, STATUS_PATH, accessToken, "POST", cfg);
    retriesUsed += s2.retriesUsed || 0;
    const d2 = pickData(s2.body);
    after = {
      today_checked_in: d2.today_checked_in,
      streak_days: d2.streak_days,
      total_credits: d2.total_credits,
      today_credit: d2.today_credit,
    };
  } catch {
    /* 复查失败不影响结论 */
  }
  detail.after = after;

  const gained = computeGained({ claimedOk, before: detail.before, after, claimData: cd });
  const streak = (after && after.streak_days) ?? cd.streak_days ?? sd.streak_days ?? null;
  const total = (after && after.total_credits) ?? sd.total_credits ?? null;

  let conclusion;
  let ok;
  if (claimedOk) {
    ok = true;
    conclusion = `✅ 签到成功 +${gained} 积分（连签 ${streak} 天，累计 ${total} 积分）`;
  } else if (alreadyCode) {
    ok = true;
    conclusion = `✅ 今日已签到（连签 ${streak} 天，累计 ${total} 积分）`;
  } else {
    ok = false;
    conclusion = `❌ 签到失败：HTTP ${cl.status} code=${normalizeCode(cl.body?.code) ?? "-"}`;
  }

  lines.push(`● 领取响应 HTTP=${cl.status} code=${normalizeCode(cl.body?.code) ?? "-"}`);
  if (after) lines.push(`● 复查 今日已签=${after.today_checked_in} 连签=${after.streak_days}天 累计=${after.total_credits} 今日获得=${after.today_credit}`);
  lines.push("→ " + conclusion);

  const result = {
    gained: ok ? gained : 0,
    streak_days: streak,
    total_credits: total,
  };
  const payload = {
    ok,
    claimed: claimedOk,
    reason: claimedOk ? "claimed" : alreadyCode ? "already" : "claim_failed",
    conclusion,
    ...basePayload(),
    ...result,
  };
  return finish(payload, ok ? 0 : 1, opt, cfg, lines);
}

// ─────────────────────────── 入口 ───────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const cfg = loadConfig();
  if (opt.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return null;
  }
  if (opt.version) {
    process.stdout.write(VERSION + "\n");
    process.exitCode = 0;
    return null;
  }
  if (opt.redactHistory) return cmdRedactHistory(cfg, opt);
  if (opt.history) return cmdHistory(cfg, opt);
  if (opt.doctor) return cmdDoctor(cfg, opt);

  if (!acquireLock(cfg)) {
    const conclusion = "⏭ 已有签到进程在运行，跳过本次触发";
    return output({ ok: true, claimed: false, skipped: true, reason: "concurrent_lock", conclusion, lines: [conclusion] }, 0, opt);
  }
  try {
    return await runCheckin(cfg, opt);
  } finally {
    releaseLock(cfg);
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (isMainModule()) {
  main().catch((e) => {
    const opt = parseArgs(process.argv.slice(2));
    const conclusion = "❌ 脚本异常：" + (e && e.message ? e.message : String(e));
    output({ ok: false, reason: "exception", conclusion, lines: ["✗ " + conclusion] }, 1, opt);
  });
}
