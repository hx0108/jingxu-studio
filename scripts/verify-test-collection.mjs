import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const searchRoots = ['apps', 'packages'];
const ignoredDirectories = new Set(['.vite', 'node_modules', 'out']);

const runners = [
  {
    name: 'e2e',
    matches: (filePath) => filePath.endsWith('.e2e.spec.ts'),
  },
  {
    name: 'contract',
    matches: (filePath) => filePath.endsWith('.contract.test.ts'),
  },
  {
    name: 'integration',
    matches: (filePath) => filePath.endsWith('.integration.test.ts'),
  },
  {
    name: 'unit',
    matches: (filePath) =>
      (filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx')) &&
      !filePath.endsWith('.contract.test.ts') &&
      !filePath.endsWith('.integration.test.ts'),
  },
];

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
};

const allFiles = (
  await Promise.all(searchRoots.map((root) => collectFiles(path.join(repositoryRoot, root))))
).flat();
const testFiles = allFiles.filter((filePath) => runners.some((runner) => runner.matches(filePath)));
const counts = new Map(runners.map((runner) => [runner.name, 0]));
const errors = [];

for (const filePath of testFiles) {
  const relativePath = path.relative(repositoryRoot, filePath).replaceAll('\\', '/');
  const owners = runners.filter((runner) => runner.matches(relativePath));

  if (owners.length !== 1) {
    errors.push(
      `${relativePath} 匹配了 ${owners.length} 个 Runner：${owners.map(({ name }) => name).join(', ')}`,
    );
    continue;
  }

  const owner = owners[0];
  if (owner === undefined) {
    errors.push(`${relativePath} 未能解析 Runner 归属。`);
    continue;
  }

  counts.set(owner.name, (counts.get(owner.name) ?? 0) + 1);
}

for (const runner of runners) {
  const count = counts.get(runner.name) ?? 0;
  if (count === 0) {
    errors.push(`${runner.name} Runner 没有测试样本。`);
  }
}

for (const runner of runners) {
  process.stdout.write(`${runner.name}: ${String(counts.get(runner.name) ?? 0)}\n`);
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`ERROR: ${error}\n`);
  }
  process.exitCode = 1;
}
