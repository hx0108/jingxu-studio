import path from 'node:path';

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

const forgeConfig = {
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
    executableName: 'jingxu-studio',
    extraResource: [migrationResourceDirectory, schemaResourceDirectory],
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
