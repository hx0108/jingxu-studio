import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-sqlite-runtime-smoke-'));
const sourcePath = path.join(root, 'source.sqlite');
const backupPath = path.join(root, 'backup.sqlite');

try {
  const source = new DatabaseSync(sourcePath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  try {
    source.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    source.exec('CREATE TABLE sample (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    source
      .prepare('INSERT INTO sample (id, payload) VALUES (?, ?)')
      .run('sample_1', '{"ready":true}');
    source.exec('COMMIT');
    assert.equal(
      source
        .prepare("SELECT json_extract(payload, '$.ready') AS ready FROM sample WHERE id = ?")
        .get('sample_1')?.ready,
      1,
    );
    await backup(source, backupPath);
  } finally {
    source.close();
  }

  const candidate = new DatabaseSync(backupPath, {
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
  });
  try {
    assert.equal(candidate.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(candidate.prepare('SELECT COUNT(*) AS count FROM sample').get()?.count, 1);
    const sqliteVersion = candidate.prepare('SELECT sqlite_version() AS version').get()?.version;
    console.log(
      JSON.stringify({
        nodeVersion: process.versions.node,
        onlineBackup: 'PASS',
        sqliteVersion,
      }),
    );
  } finally {
    candidate.close();
  }
} finally {
  await rm(root, { force: true, recursive: true });
}
