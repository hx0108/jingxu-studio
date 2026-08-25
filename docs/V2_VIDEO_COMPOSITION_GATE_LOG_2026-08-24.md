# V2 视频合成与导出门禁日志（2026-08-24）

执行环境：Windows x64、Node `v22.16.0`、pnpm `11.16.0`。SQLite Integration 与 Electron E2E 均串行执行。

| 门禁 | 实际结果 |
| --- | --- |
| `pnpm format:check` | 通过，Prettier 检查的全部文件符合格式 |
| `pnpm lint` | 通过，0 warning / 0 error |
| `pnpm typecheck` | 通过，`tsc -b` 无错误 |
| `pnpm test:collection` | 通过：e2e 19、contract 22、integration 44、unit 105，收集范围互斥 |
| `pnpm test` | 109/109 文件、935/935 用例通过 |
| `pnpm test:contract` | 22/22 文件、162/162 用例通过 |
| `pnpm test:integration` | 44/44 文件、249/249 用例通过 |
| `pnpm test:e2e` | 43 条中 40 通过、3 跳过、0 失败；跳过项均为需外部凭据的真实 Qwen/Seedream 探针 |
| V2 定向 Electron E2E | 7/7 通过；含真实 FFmpeg 成功合成及全部失败/取消/恢复分支 |
| `pnpm package:win` | 通过，生成 Windows x64 packaged app |
| `E2E-V2-VIDEO-COMPOSE-PACKAGED` | 1/1 通过，成品离线使用包内 FFmpeg/FFprobe 完成 Mock 合成 |
| `openspec validate --all --strict` | 21/21 change/spec 通过，0 失败 |

## 关键失败证据

- `E2E-V2-VIDEO-COMPOSE-FAILURE` 覆盖缺失源、`STALE_INPUT`、源文件损坏、非法裁剪、不可解码 BGM、FFmpeg 非零退出、用户取消、迟到回调和崩溃恢复。
- 每个失败分支均断言稳定错误码、Job 终态、无成功导出记录、无部分 MP4 和无残留临时文件。
- 取消终态的 `VIDEO_EXPORT_CANCELLED` 不得被迟到的 `AbortError` 覆盖，已由 SQLite Integration 与 Electron E2E 双重回归锁定。

## 打包制品

- 应用：`apps/desktop/out/镜序 Studio-win32-x64/jingxu-studio.exe`，本次打包字节数 `225441792`。
- FFmpeg：`9.0.1-essentials_build-www.gyan.dev`，`ffmpeg.exe` SHA-256 `72a489eccd008c2ec2c0a5856c5c75bc3d8bbfa90166c4566865c246445e6aa3`。
- FFprobe：`9.0.1-essentials_build-www.gyan.dev`，`ffprobe.exe` SHA-256 `19202b23c0043f15ad1b7bce2344f406fd52bd6efd8f995ce02e7392a1cec52f`。
- 来源 ZIP SHA-256：`fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`；许可证为 `GPL-3.0-or-later`，随包保留 `LICENSE.txt` 和 `NOTICE.txt`。

## 边界

本日志仅证明 `v2-video-composition-export` 的自动化、离线合成和 Windows 打包门禁。V1 三名真实目标用户试用仍是独立的发布前置条件，未由本 Change 替代。
