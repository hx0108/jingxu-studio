# Windows FFmpeg runtime resources

This directory pins the reviewed Windows x64 FFmpeg distribution used by V2
video composition. It contains `ffmpeg.exe`, `ffprobe.exe`, the upstream
`LICENSE.txt`, `NOTICE.txt`, and `ffmpeg-manifest.json`.

`package:win` fails closed when a required file is absent, its SHA-256 differs
from the manifest, or either executable does not report the fixed version.
The renderer never receives the executable paths; Electron Main resolves the
packaged resources and invokes both programs with argument arrays.
