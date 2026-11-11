---
name: workbuddy-checkin-atrest
description: WorkBuddy「Buddy 加油站」每日积分签到（适配桌面端 5.6.x 登录态字段级加密，v1.1.0 安全加固版）。当用户说「签到」「领积分」「Buddy 加油站」「今天签到领了吗」「设置每天自动领积分」「以后每天早上帮我领」「签到失败排查」「看看漏签了几天」时使用。脚本只读取本机登录态、直调官方签到接口，不需要打开界面、扫码或辅助功能授权。
agent_created: true
version: "1.1.0"
---

# WorkBuddy 加油站每日签到 v1.1.0

## 一键使用

```bash
node /path/to/workbuddy-daily-checkin/src/checkin.mjs --json
```

常用组合：

| 需求 | 命令 |
|---|---|
| 查询 + 领取（默认） | `node src/checkin.mjs` |
| 只看状态 | `node src/checkin.mjs --check-only --json` |
| 定时多次触发、当天已成功就跳过 | `node src/checkin.mjs --if-needed --json` |
| 本机环境自检（不联网） | `node src/checkin.mjs --doctor` |
| 近 30 天台账 / 漏签检测 | `node src/checkin.mjs --history=30` |
| 清洗旧版日志里的个人信息 | `node src/checkin.mjs --redact-history` |

退出码：`0` 成功 / 已签 / 跳过；`1` 失败；`2` 参数错误。
`--json` 固定字段：`ok`、`claimed`、`skipped`、`gained`、`streak_days`、`total_credits`、`conclusion`、`reason`、`version`。

向用户汇报时只取：`ok`、`claimed`、`gained`、`streak_days`、`total_credits`、`conclusion`。一行结论 + 关键数值，不要展开分析。

## 原理

桌面端 5.6.x 起把登录态敏感字段做成字段级加密：

```json
"accessToken": {"$wbEncrypted": 1, "envelope": "<base64>"}
```

因此「直接读明文 token」的旧脚本会报 `token 不是字符串` 一类错误。本 Skill 的流程：

1. **取钥**：同进程 native binding → `ELECTRON_RUN_AS_NODE=1` 起 Electron 子进程 → 用户自备 env/文件 → 仍取不到则明确报错。仓库与脚本内**不含任何编译期常量或真实凭据**。
2. **解封**：suite=1 的 AES-256-GCM，`key = sha256(utf8(atRestSecretKey))`，AAD 绑定 `field` framing 上下文，解密前校验 keyId。明文 token 只在内存中，不落盘、不打印。
3. **接口**（都是 `POST` + `{}`，GET 会 404）：

   | 动作 | 路径 |
   |---|---|
   | 查询状态 | `/v2/billing/meter/checkin-activity-status` |
   | 领取 | `/v2/billing/meter/daily-checkin` |

   域名跟随登录态里的 `auth.domain`。`code=0` 为成功，`10001`/`10002` 视为今日已签。
4. **复查**：领取后再查一次，用累计积分差值算实际到账。

## 关键路径

```
登录态  ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
密钥链  ~/.workbuddy/keyblob        (仅自检)
台账    ~/.workbuddy/logs/daily-checkin.log  (0600, 白名单脱敏)
并发锁  ~/.workbuddy/logs/daily-checkin.lock
```

全部可用 `WB_*` 环境变量覆盖，详见仓库 README。

## 配成每天定时

推荐 `--if-needed` + 一天多次触发（launchd 6/12/22 点或 cron），当天已成功则零请求跳过，既防漏签也不重复打接口。

```
automation: FREQ=DAILY;BYHOUR=6;BYMINUTE=0
prompt: 在 Bash 中执行 node <abs>/src/checkin.mjs --if-needed --json 并汇报 ok/claimed/gained/streak_days/total_credits/conclusion
```

## 排错

| 现象 | 处理 |
|---|---|
| `无法取得 at-rest 密钥` | 确认客户端已安装并登录；或设 `WB_ATREST_SECRET_B64` / `WB_SECRET_FILE` |
| `EPERM ... workbuddy-desktop.info` | 沙箱拦截，用无沙箱方式重试一次 |
| `无法解出登录令牌` / `MISMATCH` | 客户端换了加密方案/密钥，打开客户端登录一次后跑 `--doctor` |
| `登录态已过期` / `401` | 让用户打开 WorkBuddy 重新登录；**不要**手动改登录态文件 |
| `activity_inactive` | 活动未开启或接口异常，加 `--verbose` 查响应码 |
| `⏭ 已有签到进程在运行` | 另一实例持锁；10 分钟后陈旧锁自动清理 |

## 安全边界

* 只读本机登录态 + 调官方接口，**不修改**客户端任何文件，不刷新/写入令牌。
* 磁盘台账走 `LOG_WHITELIST` 白名单：不记录账号昵称、keyId、token 长度、令牌有效期、原始响应。`--verbose` 的调试细节只进 stdout。
* 从 v1.0.0 升级后执行一次 `--redact-history` 清洗历史 PII（自动备份）。
* 仅用于本人设备、本人账号；使用前确认符合平台服务条款。
