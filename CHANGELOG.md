# Changelog

All notable changes to this project are documented here. Versions follow SemVer.

## [1.1.0] - 2026-11-11

Security hardening, reliability and project scaffolding. Based on 44 real runs of v1.0.0 (2026-09-24 → 2026-11-10): 33 claims, 11 already-checked-in, 0 failures.

### Security
- Removed the hard-coded build-time `atRestSecretKey` constant from source. Key resolution is now: in-process native binding → Electron subprocess → user-supplied env/file → explicit failure. No credential material ships in the repository.
- Replaced log-blacklisting with a **field whitelist** (`LOG_WHITELIST`). Account nickname (which may contain a phone number), `keyId`, token length, token expiry, raw API responses and debug lines can no longer reach disk.
- Added `--redact-history` to scrub v1.0.0-era ledger entries, with automatic backup.
- Added `scripts/check-no-secrets.mjs` + CI gate to block accidental key / PII commits.
- Log files are created with mode `0600`.

### Reliability
- Fixed `process.exit()` truncating stdout: now sets `process.exitCode` and returns normally.
- Added bounded exponential-backoff retries (network errors / 5xx / 429). The claim endpoint never retries 5xx, preventing duplicate submissions when a response is lost.
- Added a PID lock with stale-lock recovery, so overlapping schedulers cannot run twice.
- Normalized response codes (numeric `0` and string `"0"` both work; `10001`/`10002` treated as already claimed).
- `gained` is now computed from the verified before/after credit delta instead of trusting the claim response.
- Top-level `gained` / `streak_days` / `total_credits` are present on every `--json` outcome (v1.0.0 omitted them on `already` / `check-only`).

### New capabilities
- `--if-needed` skips the network entirely when today's ledger already has a successful claim (pair with multiple daily triggers).
- `--doctor` offline environment self-check.
- `--history[=N]` ledger summary with missed-day detection.
- `--redact-history`, `--verbose`, `--no-log`, `--force`, `--version`, `--help`.
- All paths configurable via `WB_*` environment variables; `WB_API_BASE` override supported.
- Zero-dependency ESM module with exported pure functions and 14 `node:test` unit tests.
- GitHub Actions CI on Node 18/20/22, MIT license, bilingual README, launchd example, local installer, installable Skill.

### Compatibility
- `node src/checkin.mjs --json` keeps the same automation-facing fields (`ok`, `claimed`, `gained`, `streak_days`, `total_credits`, `conclusion`) and exit codes (`0` success, `1` failure).
- Still a single, zero-dependency file; no client files are modified.

## [1.0.0] - 2026-09-25

Initial standalone script: at-rest field decryption (AES-256-GCM / suite=1), status query, claim, re-check, JSON/quiet output, file log. Worked on WorkBuddy desktop 5.6.x.
