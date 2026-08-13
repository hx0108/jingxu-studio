# Verification Evidence

## Verified on

- Date: 2026-08-06
- Branch: `codex/bootstrap-electron-workspace`
- Node.js: `22.16.0`
- pnpm: `11.16.0`
- Electron: `43.3.0`

## Commands and results

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline` | Passed; lockfile unchanged |
| `pnpm peers check` | Passed; no peer dependency issues |
| `pnpm format:check` | Passed |
| `pnpm lint` | Passed with zero warnings |
| `pnpm typecheck` | Passed with strict settings and `skipLibCheck=false` |
| `pnpm test:collection` | Passed; Unit/Contract/Integration/E2E each collected exactly 1 file |
| `pnpm test` | Passed; 1 file, 5 tests |
| `pnpm test:contract` | Passed; 1 file, 5 tests |
| `pnpm test:integration` | Passed; 1 file, 1 test |
| `pnpm test:e2e` | Passed; 1 Electron test |
| `pnpm package:win` | Passed from a clean `.vite`/`out` state for Windows x64 |
| Packaged executable Playwright Smoke | Passed; page, production CSP, local-only resources, Renderer isolation and frozen empty `window.jingxu` verified |
| `openspec validate bootstrap-electron-workspace --type change --strict` | Passed; 1/1 Change |
| `openspec validate --specs --strict` | Passed; 1/1 main spec |

## Packaging evidence

- Official artifact: `electron-v43.3.0-win32-x64.zip`
- Verified SHA-256: `18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9`
- Clean `app.asar` contained `.vite/build/main.js`, `.vite/build/preload.js` and the `main_window` Renderer assets.
- The package output is generated under `apps/desktop/out/` and remains ignored by Git.

## Remaining risks and release conditions

- Electron Forge is pinned to `8.0.0-alpha.10`. It is acceptable only for the current development baseline; V1 release is blocked until migration to a compatible Forge 8 stable release passes the same gates and Windows package Smoke.
- The current network may not download Electron reliably. The documented offline path requires an official archive with a verified hash and the separate install/Packager cache variables; security and pnpm supply-chain gates must not be disabled.
- This Change implements no database, Provider, Project, script, storyboard, import/export or V2/V3 capability. No business acceptance criterion is claimed complete.
