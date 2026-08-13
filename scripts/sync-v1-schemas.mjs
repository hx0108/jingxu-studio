import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceRoot = path.join(
  repositoryRoot,
  'packages',
  'validation',
  'resources',
  'schemas',
  'v1',
);

const lockedResources = Object.freeze([
  Object.freeze({
    sourceName: '镜序Studio_V1_ScriptStageOutput.schema.json',
    resourceName: 'ScriptStageOutput.schema.json',
    sha256: '128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f',
  }),
  Object.freeze({
    sourceName: '镜序Studio_V1_ShotContract.schema.json',
    resourceName: 'ShotContract.schema.json',
    sha256: '3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b',
  }),
  Object.freeze({
    sourceName: '镜序Studio_V1_EpisodeStoryboardExport.schema.json',
    resourceName: 'EpisodeStoryboardExport.schema.json',
    sha256: '55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13',
  }),
  Object.freeze({
    sourceName: '镜序Studio_V1_ProjectTransferBundle.schema.json',
    resourceName: 'ProjectTransferBundle.schema.json',
    sha256: '9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb',
  }),
]);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const syncV1Schemas = async () => {
  const sourceBytes = new Map();
  for (const lock of lockedResources) {
    const bytes = await readFile(path.join(repositoryRoot, lock.sourceName));
    if (hash(bytes) !== lock.sha256) {
      throw new Error(`Locked source hash mismatch: ${lock.resourceName}`);
    }
    sourceBytes.set(lock.resourceName, bytes);
  }

  await mkdir(resourceRoot, { recursive: true });
  const existing = await readdir(resourceRoot);
  const expected = new Set(lockedResources.map((lock) => lock.resourceName));
  const unexpected = existing.filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error('Unexpected files exist in the V1 schema resource directory.');
  }

  for (const lock of lockedResources) {
    await copyFile(
      path.join(repositoryRoot, lock.sourceName),
      path.join(resourceRoot, lock.resourceName),
    );
    const copied = await readFile(path.join(resourceRoot, lock.resourceName));
    if (hash(copied) !== lock.sha256 || !copied.equals(sourceBytes.get(lock.resourceName))) {
      throw new Error(`Schema resource copy verification failed: ${lock.resourceName}`);
    }
  }
};

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  await syncV1Schemas();
}
