import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  VERSION, LOG_WHITELIST,
  parseArgs, loadConfig,
  buildAuthenticatedContextAad, deriveAtRestKeyId, sealEnvelope, openEnvelope,
  parseEnvelopeFromWrapper, decryptField,
  normalizeCode, isClaimSuccess, isAlreadyClaimed, computeGained, pickData,
  localDateKey, readLedger, isAlreadyDoneToday, sanitizeForLog, writeLog,
  acquireLock, releaseLock, apiCallWithRetry,
} from "../src/checkin.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-checkin-test-"));
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const cfgFor = (name) => loadConfig({
  logFile: path.join(tmp, name + ".log"),
  lockFile: path.join(tmp, name + ".lock"),
  authFile: path.join(tmp, name + ".auth"),
  keyblobFile: path.join(tmp, name + ".keyblob"),
  electronBin: path.join(tmp, "no-such-electron"),
  secretFile: path.join(tmp, name + ".secret"),
  retries: 2,
  timeoutMs: 2000,
});

test("VERSION / 白名单不含敏感字段", () => {
  assert.equal(VERSION, "1.1.0");
  for (const k of ["account", "keyId", "tokenExpiresAt", "tokenLength", "claimBody", "raw", "lines", "before", "after"]) {
    assert.ok(!LOG_WHITELIST.includes(k), k + " 不应进入落盘日志");
  }
});

test("parseArgs 各选项", () => {
  assert.deepEqual(
    (({ checkOnly, json, quiet, ifNeeded, force, doctor, history, historyDays, redactHistory, verbose, noLog }) =>
      ({ checkOnly, json, quiet, ifNeeded, force, doctor, history, historyDays, redactHistory, verbose, noLog }))(
      parseArgs(["--check-only", "--json", "--quiet", "--if-needed", "--force", "--doctor", "--history=60", "--redact-history", "--verbose", "--no-log"])
    ),
    { checkOnly: true, json: true, quiet: true, ifNeeded: true, force: true, doctor: true, history: true, historyDays: 60, redactHistory: true, verbose: true, noLog: true }
  );
  assert.equal(parseArgs([]).history, false);
  assert.equal(parseArgs(["--history"]).historyDays, 30);
  assert.equal(parseArgs(["-q"]).quiet, true);
  assert.equal(parseArgs(["--history=abc"]).historyDays, 30);
});

test("loadConfig 环境变量覆盖", () => {
  const prev = process.env.WB_TIMEOUT_MS;
  process.env.WB_TIMEOUT_MS = "4321";
  try {
    assert.equal(loadConfig().timeoutMs, 4321);
  } finally {
    if (prev === undefined) delete process.env.WB_TIMEOUT_MS; else process.env.WB_TIMEOUT_MS = prev;
  }
  assert.ok(loadConfig().authFile.startsWith(os.homedir()));
});

test("AAD 字节结构：field framing / suite=1 / sym-v1", () => {
  const keyId = "0123456789abcdef";
  const aad = buildAuthenticatedContextAad(keyId, 1, { framing: "field" });
  assert.equal(aad.subarray(0, 7).toString("ascii"), "WB-AAD\0");
  assert.equal(aad[7], 1);
  assert.ok(aad.includes(Buffer.from("WBEV1", "ascii")));
  assert.ok(aad.includes(Buffer.from("sym-v1", "ascii")));
  // framing code + 无 sequence + 无 final 是最后三个字节
  assert.deepEqual([...aad.subarray(-3)], [2, 0, 0]);
  const fileAad = buildAuthenticatedContextAad(keyId, 1, { framing: "file" });
  assert.equal(fileAad.at(-3), 1);
  assert.notDeepEqual(aad, fileAad);
  assert.throws(() => buildAuthenticatedContextAad(keyId, 1, { framing: "nope" }));
  assert.throws(() => buildAuthenticatedContextAad(keyId, 1, { framing: "field" }, "asym-v1"));
});

test("AES-256-GCM 封装/解封 round-trip（field + file）", () => {
  const key = crypto.createHash("sha256").update("unit-test-key").digest();
  assert.equal(deriveAtRestKeyId(key).length, 16);
  for (const framing of ["field", "file"]) {
    const env = sealEnvelope(key, Buffer.from("token-plaintext-" + framing), { framing });
    assert.equal(env.suite, 1);
    assert.equal(env.keyId, deriveAtRestKeyId(key));
    assert.equal(openEnvelope(key, env, { framing }).toString("utf8"), "token-plaintext-" + framing);
  }
  const env = sealEnvelope(key, Buffer.from("hello"));
  assert.throws(() => openEnvelope(crypto.createHash("sha256").update("other").digest(), env));
  const tampered = { ...env, ciphertext: Buffer.from("tampered").toString("base64") };
  assert.throws(() => openEnvelope(key, tampered));
  assert.throws(() => openEnvelope(key, env, { framing: "file" }), /bad|Unsupported|auth/i);
});

test("envelope wrapper 解析 + decryptField", () => {
  const key = crypto.createHash("sha256").update("wrapper-key").digest();
  const env = sealEnvelope(key, Buffer.from("access-token-value"));
  const wrapper = { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(env)).toString("base64") };
  assert.deepEqual(parseEnvelopeFromWrapper(wrapper), env);
  assert.equal(decryptField(key, wrapper), "access-token-value");
  assert.throws(() => parseEnvelopeFromWrapper({ accessToken: "plain" }), /wbEncrypted/);
  assert.throws(() => parseEnvelopeFromWrapper({ $wbEncrypted: 1 }), /envelope/);
  assert.throws(() => parseEnvelopeFromWrapper({ $wbEncrypted: 1, envelope: Buffer.from('{"suite":"x"}').toString("base64") }));
});

test("响应码归一化：数字/字符串都识别", () => {
  assert.equal(normalizeCode(0), "0");
  assert.equal(normalizeCode("10001"), "10001");
  assert.equal(normalizeCode(undefined), null);
  assert.equal(isClaimSuccess({ code: 0 }), true);
  assert.equal(isClaimSuccess({ code: "0" }), true);
  assert.equal(isClaimSuccess({ code: 10001 }), false);
  assert.equal(isAlreadyClaimed({ code: "10001" }), true);
  assert.equal(isAlreadyClaimed({ code: 10002 }), true);
  assert.equal(isAlreadyClaimed({ code: 0 }), false);
  assert.deepEqual(pickData({ code: 0, data: { a: 1 } }), { a: 1 });
});

test("computeGained：复查差值优先，未领取恒为 0", () => {
  const before = { total_credits: 3500, daily_credit: 100 };
  const after = { total_credits: 4600, today_credit: 100 };
  assert.equal(computeGained({ claimedOk: true, before, after, claimData: { credit: 100 } }), 1100);
  assert.equal(computeGained({ claimedOk: true, before, after: null, claimData: { credit: 100 } }), 100);
  assert.equal(computeGained({ claimedOk: true, before: null, after: null, claimData: {} }), 0);
  assert.equal(computeGained({ claimedOk: false, before, after, claimData: { credit: 999 } }), 0);
});

test("localDateKey 使用本机本地时区", () => {
  const d = new Date(2026, 10, 11, 8, 0, 0);
  assert.equal(localDateKey(d), "2026-11-11");
  assert.equal(localDateKey("2026-11-11T00:30:00Z") !== "", true);
  assert.equal(localDateKey("not-a-date"), "");
});

test("sanitizeForLog 白名单过滤个人信息", () => {
  const payload = {
    ts: "2026-11-11T00:00:00.000Z", ok: true, claimed: true, conclusion: "ok",
    gained: 100, streak_days: 35, total_credits: 3500,
    account: "private-nickname", keyId: "deadbeefdeadbeef",
    tokenExpiresAt: "2026-12-11T00:00:00.000Z", claimBody: { code: 0 },
    before: { total_credits: 3400 }, lines: ["private"], raw: { secret: 1 },
  };
  const safe = sanitizeForLog(payload);
  assert.equal(safe.gained, 100);
  assert.equal(safe.total_credits, 3500);
  for (const k of ["account", "keyId", "tokenExpiresAt", "claimBody", "before", "lines", "raw"]) {
    assert.equal(k in safe, false, k + " 被泄漏到日志");
  }
  assert.equal(safe.ts, payload.ts);
});

test("writeLog / readLedger 容错与脱敏落地", () => {
  const cfg = cfgFor("log");
  writeLog({ started: "2026-11-11T00:00:00.000Z", ok: true, claimed: true, gained: 100, account: "private" }, cfg);
  fs.appendFileSync(cfg.logFile, "NOT-JSON\n", "utf8");
  const rows = readLedger(cfg);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gained, 100);
  assert.equal("account" in rows[0], false);
});

test("isAlreadyDoneToday 边界", () => {
  const today = localDateKey();
  const yesterday = localDateKey(new Date(Date.now() - 86400000));
  assert.equal(isAlreadyDoneToday([{ ts: new Date().toISOString(), ok: true, claimed: true }], today), true);
  assert.equal(isAlreadyDoneToday([{ ts: new Date().toISOString(), ok: true, claimed: false, reason: "already" }], today), true);
  assert.equal(isAlreadyDoneToday([{ ts: new Date().toISOString(), ok: true, claimed: false, reason: "check-only" }], today), false);
  assert.equal(isAlreadyDoneToday([{ ts: new Date().toISOString(), ok: false, reason: "network" }], today), false);
  assert.equal(isAlreadyDoneToday([{ ts: new Date().toISOString(), ok: true, claimed: true, skipped: true }], today), false);
  assert.equal(isAlreadyDoneToday([{ ts: new Date(Date.now() - 86400000).toISOString(), ok: true, claimed: true }], yesterday), true);
  assert.equal(isAlreadyDoneToday([], today), false);
});

test("并发锁：二次获取失败、释放后可再获取、stale 自动清理", () => {
  const cfg = cfgFor("lock");
  assert.equal(acquireLock(cfg), true);
  assert.equal(acquireLock(cfg), false);
  releaseLock(cfg);
  assert.equal(acquireLock(cfg), true);
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(cfg.lockFile, old, old);
  assert.equal(acquireLock(cfg), true);
  releaseLock(cfg);
});

test("apiCallWithRetry：网络错误退避重试；领取接口不重试 5xx", async () => {
  const cfg = cfgFor("http");
  const origFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return { status: 200, text: async () => '{"code":0,"data":{"ok":1}}' };
    };
    const r1 = await apiCallWithRetry("https://example.invalid", "/x", "t", "POST", { ...cfg, retries: 2 });
    assert.equal(r1.status, 200);
    assert.equal(calls, 3);
    assert.equal(r1.retriesUsed, 2);

    calls = 0;
    globalThis.fetch = async () => { calls += 1; return { status: 503, text: async () => "{}" }; };
    const r2 = await apiCallWithRetry("https://example.invalid", "/x", "t", "POST", { ...cfg, retries: 2 });
    assert.equal(r2.status, 503);
    assert.equal(calls, 3);

    calls = 0;
    const r3 = await apiCallWithRetry("https://example.invalid", "/x", "t", "POST", { ...cfg, retries: 2 }, { retryOn5xx: false });
    assert.equal(r3.status, 503);
    assert.equal(calls, 1, "领取接口遇 5xx 不应重试");
  } finally {
    globalThis.fetch = origFetch;
  }
});
