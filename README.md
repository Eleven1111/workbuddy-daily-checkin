# WorkBuddy 加油站每日签到

[![CI](https://github.com/Eleven1111/workbuddy-daily-checkin/actions/workflows/ci.yml/badge.svg)](https://github.com/Eleven1111/workbuddy-daily-checkin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> 在终端完成 WorkBuddy「Buddy 加油站」的每日签到与积分领取，无需打开客户端界面。

## 产品概述

**WorkBuddy 加油站每日签到**（下称「本工具」）是一个零依赖命令行工具。它读取本机的 WorkBuddy 登录态，调用官方签到接口完成每日签到，并把结果写入本地台账。

本工具解决以下问题：

| 场景 | 问题 | 本工具的解法 |
|---|---|---|
| 每日签到 | 需要打开客户端手动点击，容易遗忘 | 一条命令或一个定时任务自动完成 |
| 定时执行 | 单次触发可能延后，导致漏签 | 一天多次触发，配合幂等判断只真正领取一次 |
| 结果追溯 | 平台只展示连续天数，不提供明细 | 本地台账记录每日结果，支持漏签检测 |
| 凭据安全 | 明文令牌易被脚本复制、落盘 | 令牌只在内存中流转，台账按字段白名单脱敏 |

### 术语表

| 术语 | 说明 |
|---|---|
| 加油站 | WorkBuddy 客户端的积分活动页面，每日签到可领取积分 |
| 登录态 | 客户端保存在本机的会话信息，本工具从中读取访问令牌 |
| at-rest 加密 | 客户端对落盘敏感字段做的字段级加密，密文形如 `{"$wbEncrypted":1,"envelope":"..."}` |
| 台账 | 本工具写入的本地记录文件，每行一条 JSON |

### 适用范围

本工具仅用于**本人设备、本人账号**的日常签到。它不代登录、不刷新令牌、不修改客户端任何文件。使用前请确认符合所使用平台的服务条款。

## 产品优势

- **零依赖**：单个 `.mjs` 文件，无需 `npm install`，Node.js 18 及以上直接运行。
- **不侵入客户端**：只读登录态并调用官方签到接口，不写入、不改装、不注入。
- **默认脱敏**：台账按字段白名单写入，账号昵称、密钥标识、令牌有效期一律不落盘。
- **可自愈**：客户端升级后，密钥经运行时链路重新获取，无需改代码。
- **可审计**：每日结果留档，支持按天回溯与漏签检测。

## 功能特性

| 特性 | 说明 |
|---|---|
| 每日签到 | 查询状态，未签到则领取，领取后复查确认到账 |
| 积分核算 | 用复查前后的累计积分差值计算实际到账，不依赖响应字段 |
| 幂等跳过 | 当天台账已有成功记录时直接跳过，不发起网络请求 |
| 并发保护 | 进程锁避免多个定时任务同时领取；陈旧锁自动回收 |
| 失败重试 | 网络异常、`5xx`、`429` 按指数退避重试；领取接口不重试 `5xx`，防止重复提交 |
| 离线自检 | `--doctor` 检查本机环境，不发起网络请求 |
| 台账统计 | `--history` 输出每日结果、累计积分与疑似漏签日期 |
| 历史清洗 | `--redact-history` 清洗旧版本台账中的个人信息，自动备份 |
| 机器可读输出 | `--json` 输出固定字段，便于接入自动化任务 |

## 应用场景

| 场景 | 建议用法 |
|---|---|
| 个人日常签到 | 每天手动执行一次 `node src/checkin.mjs` |
| 自动化任务托管 | 每日触发 `--if-needed --json`，由任务读取结果字段汇报 |
| 防止漏签 | launchd 或 cron 一天触发三次，幂等判断保证只领取一次 |
| 台账复盘 | 定期执行 `--history=30`，核对连续天数与实际到账 |

## 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS（读取客户端默认安装路径）；Linux 需通过环境变量指定路径 |
| 运行时 | Node.js 18 及以上 |
| 客户端 | 已安装 WorkBuddy 桌面端，并至少登录一次 |
| 网络 | 可访问签到服务域名，默认跟随登录态中的 `auth.domain` |

## 安装

1. 获取代码。

   ```bash
   git clone https://github.com/Eleven1111/workbuddy-daily-checkin.git
   cd workbuddy-daily-checkin
   ```

2. 检查本机环境。该命令不联网。

   ```bash
   node src/checkin.mjs --doctor
   ```

   预期输出：

   ```text
   ● Electron=ok 登录态=ok keyblob=ok
   ● 密钥来源=electron-subprocess 自检=ok 令牌可解密=true
   → ✅ 本机环境自检通过（未联网）
   ```

3. 将脚本安装到固定路径（可选，供定时任务引用）。

   ```bash
   bash scripts/install-local.sh
   ```

## 快速入门

1. 查询签到状态，不领取积分。

   ```bash
   node src/checkin.mjs --check-only --json
   ```

2. 执行签到。未签到则领取，已签到则直接返回。

   ```bash
   node src/checkin.mjs --json
   ```

   领取成功时输出：

   ```json
   {
     "ok": true,
     "claimed": true,
     "reason": "claimed",
     "gained": 100,
     "streak_days": 36,
     "total_credits": 3600,
     "conclusion": "✅ 签到成功 +100 积分（连签 36 天，累计 3600 积分）"
   }
   ```

3. 核对台账。

   ```bash
   node src/checkin.mjs --history=7
   ```

## 使用指南

### 命令参数

| 参数 | 说明 | 默认值 |
|---|---|---|
| 无参数 | 查询状态，未签到则领取，然后复查 | — |
| `--check-only` | 只查询状态，不领取 | 关闭 |
| `--if-needed` | 当天台账已有成功记录时跳过，不发起网络请求 | 关闭 |
| `--force` | 忽略 `--if-needed` 的跳过判断 | 关闭 |
| `--doctor` | 离线自检本机环境 | 关闭 |
| `--history[=N]` | 输出近 N 天台账与漏签检测 | `30` |
| `--redact-history` | 清洗旧版本台账中的个人信息，自动备份 | 关闭 |
| `--json` | 输出机器可读 JSON | 关闭 |
| `--quiet` | 只输出一行结论 | 关闭 |
| `--verbose` | 输出调试细节，仅打印不落盘 | 关闭 |
| `--no-log` | 本次不写台账 | 关闭 |
| `--version` | 输出版本号 | — |
| `--help` | 输出完整用法 | — |

### 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 签到成功、今日已签到、已跳过或仅查询 |
| `1` | 执行失败，原因见 `reason` 与 `conclusion` 字段 |
| `2` | 参数错误 |

### 输出字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | 布尔 | 本次执行是否成功 |
| `claimed` | 布尔 | 本次是否实际领取积分 |
| `skipped` | 布尔 | 是否因幂等判断或并发锁而跳过 |
| `reason` | 字符串 | 结果原因，取值见下文 |
| `gained` | 数字 | 本次到账积分 |
| `streak_days` | 数字 | 连续签到天数 |
| `total_credits` | 数字 | 累计积分 |
| `conclusion` | 字符串 | 一行结论，可直接用于汇报 |

`reason` 取值：`claimed`、`already`、`check-only`、`already_done_today`、`concurrent_lock`、`token_expired`、`token_undecryptable`、`missing_atrest_key`、`auth_unreadable`、`unauthorized`、`activity_inactive`、`network`、`claim_failed`、`exception`。

### 配置项

所有路径均有默认值，通常无需配置。如需调整，通过环境变量覆盖。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WB_ELECTRON_BIN` | `/Applications/WorkBuddy.app/Contents/MacOS/Electron` | 取密钥使用的客户端可执行文件 |
| `WB_AUTH_FILE` | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | 登录态文件路径 |
| `WB_KEYBLOB_FILE` | `~/.workbuddy/keyblob` | 密钥链文件，仅用于自检 |
| `WB_LOG_FILE` | `~/.workbuddy/logs/daily-checkin.log` | 台账文件路径 |
| `WB_LOCK_FILE` | `~/.workbuddy/logs/daily-checkin.lock` | 进程锁路径 |
| `WB_SECRET_FILE` | `~/.config/workbuddy-checkin/atrest-secret` | 自备密钥文件，权限需为 `0600` |
| `WB_ATREST_SECRET_B64` | 无 | 自备密钥，仅通过环境变量传入 |
| `WB_API_BASE` | 跟随 `auth.domain` | 接口地址覆盖 |
| `WB_TIMEOUT_MS` | `20000` | 单次请求超时时间，单位毫秒 |
| `WB_RETRIES` | `2` | 重试次数，上限 `5` |

参考模板见 `config.example.json`。

## 部署

### 方式一：自动化任务

创建每日执行的任务，执行以下命令：

```bash
node /绝对路径/src/checkin.mjs --if-needed --json
```

任务读取 `ok`、`claimed`、`skipped`、`gained`、`streak_days`、`total_credits`、`conclusion` 字段汇报即可。`skipped` 为 `true` 表示当天已完成，属正常结果。

### 方式二：launchd

模板位于 `deploy/com.eleven1111.workbuddy-checkin.plist`，默认在 `06:00`、`12:00`、`22:00` 触发。

```bash
sed -e "s|__NODE_BIN__|$(command -v node)|g" \
    -e "s|__REPO_PATH__|$PWD|g" \
    -e "s|__HOME__|$HOME|g" \
    deploy/com.eleven1111.workbuddy-checkin.plist \
  > ~/Library/LaunchAgents/com.eleven1111.workbuddy-checkin.plist

launchctl load ~/Library/LaunchAgents/com.eleven1111.workbuddy-checkin.plist
```

### 方式三：cron

```cron
0 6,12,22 * * * /usr/bin/node /绝对路径/src/checkin.mjs --if-needed --quiet >> /tmp/wb-checkin.log 2>&1
```

多次触发的成本可控：当天已成功时，`--if-needed` 不发起任何网络请求。

## 工作原理

### 处理流程

1. 从客户端运行时获取 at-rest 密钥，按「同进程绑定 → 客户端子进程 → 用户自备」顺序尝试。
2. 解封登录态中的访问令牌。令牌只在内存中流转。
3. 调用签到状态接口，判断今日是否已签到。
4. 未签到时调用领取接口，随后复查一次状态。
5. 按字段白名单写入台账，并输出结果。

### 接口说明

| 动作 | 方法 | 路径 |
|---|---|---|
| 查询签到状态 | `POST` | `/v2/billing/meter/checkin-activity-status` |
| 领取每日积分 | `POST` | `/v2/billing/meter/daily-checkin` |

请求头包含 `Authorization: Bearer <token>` 与 `Content-Type: application/json`，请求体为 `{}`。返回 `code` 为 `0` 表示成功，`10001`、`10002` 表示今日已领取。

### 数据文件

| 文件 | 权限 | 说明 |
|---|---|---|
| 台账 | `0600` | 每行一条 JSON，仅含白名单字段 |
| 进程锁 | `0600` | 记录进程号与创建时间，超过 10 分钟视为陈旧 |
| 备份 | 继承源文件 | `--redact-history` 执行前自动生成 |

## 安全说明

- 仓库不包含任何编译期密钥、真实令牌、账号信息或密钥标识。
- 台账按白名单写入。账号昵称、密钥标识、令牌长度、令牌有效期、原始响应均不落盘。
- `--verbose` 输出的调试信息只写入标准输出，不写入台账。
- 登录态过期时直接退出并提示重新登录，不刷新、不改写凭据。
- 从 1.0.0 升级后，建议执行一次历史清洗：

  ```bash
  node src/checkin.mjs --redact-history
  ```

- 提交前运行 `npm run audit:secrets`，检查是否存在疑似密钥与个人信息。CI 已内置相同检查。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `无法取得 at-rest 密钥` | 客户端未安装、未登录，或运行环境无原生模块 | 确认客户端已登录；或设置 `WB_ATREST_SECRET_B64`、`WB_SECRET_FILE` |
| `无法解出登录令牌` | 客户端升级后更换了加密方案或密钥 | 打开客户端登录一次，再执行 `--doctor` |
| `keyblobCheck=MISMATCH` | 派生密钥与密钥链不匹配 | 同上；确认未被其他工具改写登录态 |
| `登录态已过期` 或 `401` | 会话失效 | 打开客户端重新登录，本工具不会自行刷新 |
| `activity_inactive` | 活动未开启或接口返回异常 | 添加 `--verbose` 查看响应码 |
| `EPERM` 读取登录态失败 | 命令被沙箱拦截 | 以无沙箱方式重试一次 |
| 今日已签到，跳过本次请求 | `--if-needed` 生效 | 正常结果；需强制请求时添加 `--force` |
| 已有签到进程在运行 | 另一实例持有进程锁 | 等待本次执行结束；陈旧锁 10 分钟后自动回收 |

## 参与贡献

1. 从 `main` 切出分支：`git checkout -b feat/your-change`。
2. 提交前运行 `npm run verify`，确保语法检查、单元测试、防泄露扫描全部通过。
3. 提交合并请求，说明改动目的与验证方式。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 更新日志

版本变更见 [CHANGELOG.md](CHANGELOG.md)。当前版本 `1.1.0` 的主要变化：

- 移除源码内的编译期密钥，改为运行时获取。
- 台账改为字段白名单写入，新增历史清洗命令。
- 修复标准输出截断，新增重试、进程锁与幂等跳过。

## English Summary

A zero-dependency Node.js CLI for the daily credit check-in of WorkBuddy. It reads the local session, calls the official check-in endpoints, and records a redacted ledger. Key commands: `--check-only`, `--if-needed`, `--doctor`, `--history[=N]`, `--redact-history`. Requires Node.js 18 or later. Intended for personal use on your own device and account only.
