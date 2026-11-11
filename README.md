# WorkBuddy 加油站每日签到 / Daily Check-in CLI

> 零依赖、单文件、不需要打开客户端界面的每日积分签到工具。v1.1.0 是 v1.0.0 的**安全加固 + 可靠性重构版**：清掉硬编码密钥、给日志加白名单脱敏、修输出截断、加幂等调度与自诊断，并补齐测试、CI 与文档。

**结论先行**：本机 v1.0.0 连续跑了 48 天（44 条台账：33 次领取、11 次已签、0 失败，连签 35 天 / 3500 积分），主链路稳定，所以 v1.1.0 **不动签到协议**，只修工程问题。最大风险不是功能，而是 **v1.0.0 把含手机号的账号昵称、keyId、令牌有效期写进了 `--json` 与磁盘日志** —— 这版已彻底移除。

---

## 前后对比 / What changed

| 维度 | v1.0.0 | v1.1.0 |
|---|---|---|
| 编译期密钥 | 源码内硬编码常量，公开发布即泄露 | **零硬编码**。运行时取钥：native binding → Electron 子进程 → 用户自备 env/file → 明确报错 |
| 日志 | 整包 payload 落盘，含账号昵称（可能含手机号）、keyId、令牌有效期、原始响应 | **字段白名单**，仅积分/天数/HTTP 状态/结论；文件权限 `0600` |
| 历史日志 | 已含 PII，无处理手段 | `--redact-history` 清洗 + 自动备份 |
| 输出 | `process.exit()` 可能截断 stdout | 设置 `process.exitCode` 后正常返回 |
| 网络 | 一次失败即退出，0 重试 | 指数退避重试（网络错误 / 5xx / 429），领取接口 5xx 不重试防重复提交 |
| 并发 | 无保护，多个定时器可同时打接口 | PID 锁 + 陈旧锁自动清理 |
| 响应码 | 只认数字 `0` | 数字/字符串归一化，`10001`/`10002` 判为已签 |
| 积分计算 | 信任领取响应字段 | 复查前后累计积分差值优先 |
| 定时漏跑 | 只能靠单次触发 | `--if-needed` + 多次触发（launchd/cron），当天已成功则零请求跳过 |
| 可维护性 | 474 行单文件，无测试 | 导出纯函数 + 14 个单测 + CI(Node 18/20/22) + 防泄露扫描 |
| 可配置性 | 路径全硬编码 | 全部 `WB_*` 环境变量可覆盖 |
| 兼容 | — | `--json` 字段与退出码 `0/1` 完全保持，automation 无需改动 |

**新增命令**：`--doctor`（离线自检）、`--history[=N]`（台账 / 漏签检测）、`--redact-history`、`--if-needed`、`--force`、`--verbose`、`--no-log`、`--version`、`--help`。

---

## 快速开始 / Quick start

```bash
git clone https://github.com/Eleven1111/workbuddy-daily-checkin.git
cd workbuddy-daily-checkin

npm run doctor        # 离线自检：密钥链 / 登录态 / keyblob
npm run check         # 只查询，不领取
npm run checkin       # 查询 + 领取 + 复查
npm run verify        # 语法 + 14 单测 + 防泄露扫描
```

主脚本 `src/checkin.mjs` 是**零依赖单文件**，可单独复制到任何地方直接 `node` 运行，不需要 `npm install`：

```bash
node /abs/path/to/checkin.mjs --if-needed --quiet
```

前置条件：Node >= 18、WorkBuddy 桌面端已安装并登录过一次（登录态在本地）、网络可达签到服务。

---

## 定时自动领 / Scheduling

### 方案 A：WorkBuddy 自动化（现有方式）

创建每日任务，prompt 中执行：

```bash
node /abs/path/to/checkin.mjs --if-needed --json
```

解析 `ok / claimed / gained / streak_days / total_credits / conclusion` 汇报即可。`skipped=true` 表示当天已完成、本次未请求接口。

### 方案 B：macOS launchd（推荐兜底）

`deploy/com.eleven1111.workbuddy-checkin.plist` 每天 **06:00 / 12:00 / 22:00** 触发三次，靠 `--if-needed` 保证只真正领取一次。客户端没开、自动化延迟时也不会漏签。

```bash
sed -e "s|__NODE_BIN__|$(command -v node)|g" \
    -e "s|__REPO_PATH__|$PWD|g" \
    -e "s|__HOME__|$HOME|g" \
    deploy/com.eleven1111.workbuddy-checkin.plist \
  > ~/Library/LaunchAgents/com.eleven1111.workbuddy-checkin.plist
launchctl load ~/Library/LaunchAgents/com.eleven1111.workbuddy-checkin.plist
```

### 方案 C：cron（Linux / macOS）

```cron
0 6,12,22 * * * /usr/bin/node /abs/path/to/checkin.mjs --if-needed --quiet >> /tmp/wb-checkin.log 2>&1
```

> 为什么一天三次：真实台账显示单次 06:00 触发曾延后近 2 小时，调试期有 10 天无成功记录。多次触发 + 幂等跳过的成本是「已成功时 0 次网络请求」，收益是不漏签。

---

## CLI

| 选项 | 作用 |
|---|---|
| (无) | 查询 → 未签则领取 → 复查 |
| `--check-only` | 只查询 |
| `--if-needed` | 当天台账已有成功记录则直接跳过，不联网 |
| `--force` | 忽略 `--if-needed` 的跳过判断 |
| `--doctor` | 离线自检，不联网 |
| `--history[=N]` | 近 N 天台账、累计积分、疑似漏签日期（默认 30） |
| `--redact-history` | 清洗 v1.0.0 遗留日志中的个人信息，自动备份 |
| `--json` / `--quiet` | 机器可读 JSON / 一行结论 |
| `--verbose` | 输出调试细节（令牌有效期、原始响应）；**仅打印，不落盘** |
| `--no-log` | 本次不写台账 |
| `--version` / `--help` | 版本号 / 完整用法 |

退出码：`0` 成功、已签、跳过；`1` 失败；`2` 参数错误（保留）。

`--json` 关键字段：

```json
{
  "ok": true, "claimed": true, "skipped": false, "reason": "claimed",
  "gained": 100, "streak_days": 36, "total_credits": 3600,
  "conclusion": "✅ 签到成功 +100 积分（连签 36 天，累计 3600 积分）",
  "duration_ms": 1100, "retriesUsed": 0, "version": "1.1.0"
}
```

---

## 配置 / Environment variables

全部有默认值，通常无需设置。见 `config.example.json`。

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WB_ELECTRON_BIN` | `/Applications/WorkBuddy.app/Contents/MacOS/Electron` | 取密钥用的客户端 Electron |
| `WB_AUTH_FILE` | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | 登录态文件 |
| `WB_KEYBLOB_FILE` | `~/.workbuddy/keyblob` | 密钥链自检 |
| `WB_LOG_FILE` | `~/.workbuddy/logs/daily-checkin.log` | 台账（JSONL） |
| `WB_LOCK_FILE` | `~/.workbuddy/logs/daily-checkin.lock` | 并发锁 |
| `WB_SECRET_FILE` | `~/.config/workbuddy-checkin/atrest-secret` | 自备密钥文件（需 `0600`） |
| `WB_ATREST_SECRET_B64` | — | 自备密钥（仅环境变量，勿写文件） |
| `WB_API_BASE` | 跟随登录态里的 `auth.domain` | 接口域名覆盖 |
| `WB_TIMEOUT_MS` | `20000` | 单次 HTTP 超时 |
| `WB_RETRIES` | `2`（上限 5） | 重试次数 |

---

## 工作原理 / How it works

1. 桌面端把登录态里的敏感字段包装成 `{"$wbEncrypted":1,"envelope":"<base64>"}`（suite=1，AES-256-GCM）。
2. 脚本从客户端运行时取得 `atRestSecretKey`，派生 `sha256(utf8(key))` 作为解封密钥，并用 AAD 绑定 `field` framing 上下文。
3. 明文 `accessToken` **只在内存中**存在，用于 `POST /v2/billing/meter/checkin-activity-status` 与 `POST /v2/billing/meter/daily-checkin`。
4. 领取后复查一次状态，用累计积分差值算实际到账。
5. 全程**只读**本机登录态，**不修改**客户端任何文件，不刷新、不写入令牌。

`skill/SKILL.md` 是可安装的 WorkBuddy Skill 版本。

---

## 安全边界 / Safety

- 仓库**不含**任何编译期常量、真实 token、账号信息或 keyId；`npm run audit:secrets` + CI 会拦截疑似密钥与手机号。
- 日志走白名单，新增字段默认不落盘；`--verbose` 的敏感细节只进 stdout。
- 从 v1.0.0 升级后，建议对旧台账执行一次：

  ```bash
  node src/checkin.mjs --redact-history
  # 原文件自动备份为 ~/.workbuddy/logs/daily-checkin.log.v1.0.0.bak
  ```

- 登录态过期时脚本直接退出并提示重新登录，**不会**尝试刷新或改写凭据。
- 仅用于**本人设备、本人账号**的日常签到。使用前请确认符合所使用平台的服务条款；作者不对账号风险、接口变更或积分规则变化负责。

## 排错 / Troubleshooting

| 现象 | 处理 |
|---|---|
| `无法取得 at-rest 密钥` | 确认桌面端已安装并登录；或设置 `WB_ATREST_SECRET_B64` / `WB_SECRET_FILE` |
| `EPERM ... workbuddy-desktop.info` | 命令被沙箱拦截；以无沙箱方式重试一次 |
| `无法解出登录令牌` / `MISMATCH` | 客户端换了加密方案或密钥，先打开客户端登录一次，再跑 `--doctor` |
| `登录态已过期` / `401` | 打开客户端重新登录，脚本不会自己刷新 |
| `activity_inactive` | 活动未开启或接口返回异常，加 `--verbose` 看响应码 |
| `⏭ 今日已签到，跳过` | `--if-needed` 生效；如需强制请求加 `--force` |
| `⏭ 已有签到进程在运行` | 另一实例持锁；10 分钟后陈旧锁会自动清理 |

## 验收清单 / Acceptance

- [x] `node --check src/checkin.mjs` 通过
- [x] `npm test` — 14/14 通过（crypto round-trip、AAD、脱敏、幂等、锁、重试策略）
- [x] `npm run audit:secrets` 通过
- [x] `--doctor --json` 实测 `ok:true`
- [x] `--check-only --json` 实测返回真实积分，日志无 PII
- [x] `--if-needed` 实测零请求跳过
- [x] `--json` 字段与退出码向后兼容
- [x] CI 覆盖 Node 18 / 20 / 22

---

## English summary

A zero-dependency Node CLI that performs the WorkBuddy "Buddy 加油站" daily credit check-in without opening the desktop UI. It decrypts the local at-rest session field (AES-256-GCM, suite=1), queries the official status endpoint, claims once, then re-checks. v1.1.0 removes a hard-coded build-time key, enforces a whitelist-based redacted ledger, fixes stdout truncation on `process.exit`, adds bounded retries, an idempotent `--if-needed` mode, a PID lock, `--doctor`, `--history`, `--redact-history`, env-var configuration, 14 unit tests and CI. All paths and credentials stay on the local machine; the repository contains no secrets. For personal use on your own account only — check the platform's terms of service before use.

## License

MIT © 2026 Eleven1111
