import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const electronArtifactName = 'electron-v43.3.0-win32-x64.zip';
// 默认钉死官方发布制品的 sha256（供应链完整性）。离线/本地 electron 重建打包时，
// 可经 JINGXU_ELECTRON_SHA256 覆盖为本地可信制品（如 node_modules/electron/dist 重建 zip）的哈希。
const electronArtifactSha256 =
  process.env.JINGXU_ELECTRON_SHA256 ??
  '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9';
const electronCacheRoot = process.env.ELECTRON_CACHE;
const electronZipDirectory = process.env.JINGXU_ELECTRON_ZIP_DIR;
export const migrationResourceDirectory = path.resolve(
  import.meta.dirname,
  '../../packages/persistence/resources/migrations',
);
export const schemaResourceDirectory = path.resolve(
  import.meta.dirname,
  '../../packages/validation/resources/schemas',
);
export const ffmpegResourceDirectory = path.resolve(import.meta.dirname, 'resources/ffmpeg');

interface FfmpegResourceManifest {
  readonly files: Readonly<Record<'ffmpeg.exe' | 'ffprobe.exe' | 'LICENSE.txt', string>>;
  readonly version: string;
}

const FFMPEG_REQUIRED_FILES = ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt', 'NOTICE.txt'] as const;
const FFMPEG_HASHED_FILES = ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readFfmpegManifest = (directory: string): FfmpegResourceManifest => {
  const manifestPath = path.join(directory, 'ffmpeg-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`FFMPEG_RESOURCE_MISSING: ${manifestPath}`);
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`FFMPEG_RESOURCE_INVALID_MANIFEST: ${manifestPath}`);
  }
  const parsedFiles = parsed.files;
  if (!isRecord(parsedFiles)) {
    throw new Error(`FFMPEG_RESOURCE_INVALID_MANIFEST: ${manifestPath}`);
  }

  const readHash = (name: (typeof FFMPEG_HASHED_FILES)[number]): string => {
    const value = parsedFiles[name];
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(`FFMPEG_RESOURCE_INVALID_MANIFEST: ${manifestPath}`);
    }
    return value;
  };

  return {
    files: {
      'ffmpeg.exe': readHash('ffmpeg.exe'),
      'ffprobe.exe': readHash('ffprobe.exe'),
      'LICENSE.txt': readHash('LICENSE.txt'),
    },
    version: parsed.version,
  };
};

export const assertFfmpegResources = (directory: string): void => {
  const manifest = readFfmpegManifest(directory);
  for (const file of FFMPEG_REQUIRED_FILES) {
    const resourcePath = path.join(directory, file);
    if (!fs.existsSync(resourcePath)) {
      throw new Error(`FFMPEG_RESOURCE_MISSING: ${resourcePath}`);
    }
  }

  for (const file of FFMPEG_HASHED_FILES) {
    const resourcePath = path.join(directory, file);
    const actualHash = createHash('sha256').update(fs.readFileSync(resourcePath)).digest('hex');
    if (actualHash !== manifest.files[file]) {
      throw new Error(`FFMPEG_RESOURCE_HASH_MISMATCH: ${resourcePath}`);
    }
  }

  for (const binary of ['ffmpeg.exe', 'ffprobe.exe'] as const) {
    const versionOutput = execFileSync(path.join(directory, binary), ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!versionOutput.includes(`version ${manifest.version}`)) {
      throw new Error(`FFMPEG_RESOURCE_VERSION_MISMATCH: ${path.join(directory, binary)}`);
    }
  }
};

const forgeConfig = {
  // 旧包仍在运行时可指定独立输出目录，避免打包过程尝试删除被 Windows 锁定的目录。
  outDir: process.env.JINGXU_FORGE_OUT_DIR ?? 'out',
  makers: [
    {
      config: {
        name: 'jingxu_studio',
      },
      name: '@electron-forge/maker-squirrel',
    },
  ],
  packagerConfig: {
    asar: true,
    download: {
      checksums: {
        [electronArtifactName]: electronArtifactSha256,
      },
      ...(electronCacheRoot === undefined ? {} : { cacheRoot: electronCacheRoot }),
    },
    ...(electronZipDirectory === undefined ? {} : { electronZipDir: electronZipDirectory }),
    // 磁盘受限的离线打包可设 JINGXU_PACKAGER_TMPDIR=0：跳过临时模板目录直写输出，
    // 峰值磁盘占用减半（模板目录默认落在系统盘 os.tmpdir，全盘吃紧时会 ENOSPC）。
    ...(process.env.JINGXU_PACKAGER_TMPDIR === '0' ? { tmpdir: false } : {}),
    executableName: 'jingxu-studio',
    extraResource: [migrationResourceDirectory, schemaResourceDirectory, ffmpegResourceDirectory],
    // Electron Packager 在该回调之前才完成 extraResource 复制；packageAfterCopy
    // 发生得更早，无法验证最终随包的 FFmpeg 制品。
    afterCopyExtraResources: [
      ({ buildPath }: { readonly buildPath: string }) => {
        assertFfmpegResources(path.join(buildPath, 'resources', 'ffmpeg'));
      },
    ],
  },
  plugins: [
    {
      config: {
        build: [
          {
            config: 'vite.main.config.ts',
            entry: 'src/main/main.ts',
            target: 'main',
          },
          {
            config: 'vite.preload.config.ts',
            entry: 'src/preload/preload.ts',
            target: 'preload',
          },
        ],
        renderer: [
          {
            config: 'vite.renderer.config.ts',
            name: 'main_window',
          },
        ],
      },
      name: '@electron-forge/plugin-vite',
    },
  ],
};

export default forgeConfig;
