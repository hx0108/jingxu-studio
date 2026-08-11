import path from 'node:path';

const electronArtifactName = 'electron-v43.3.0-win32-x64.zip';
const electronArtifactSha256 = '18528bedc6a9b04bdc5efb7b803cbc3cb0e5ea6415d54046e23d464d89a00da9';
const electronCacheRoot = process.env.ELECTRON_CACHE;
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
