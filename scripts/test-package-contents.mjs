#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = await mkdtemp(path.join(os.tmpdir(), 'requirements-refiner-npm-cache-'));
let output;
try {
  output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
  });
} finally {
  await rm(cache, { recursive: true, force: true });
}
const report = JSON.parse(output)[0];
const files = (report.files ?? []).map((item) => item.path);
const errors = [];
const required = [
  'package.json',
  '.codex-plugin/plugin.json',
  'bin/requirements-refiner.mjs',
  'lib/installer.mjs',
  'skills/requirements-refiner/SKILL.md',
];
for (const target of required) if (!files.includes(target)) errors.push(`tarball 缺少 ${target}`);
for (const file of files) {
  if (/^(?:docs|test|_sources)\//u.test(file)) errors.push(`tarball 包含禁止目录：${file}`);
  if (/(?:^|\/)\.npmrc$/u.test(file)) errors.push(`tarball 包含 npm 配置：${file}`);
  if (/\.tgz$/u.test(file)) errors.push(`tarball 嵌套压缩包：${file}`);
  if (path.isAbsolute(file)) errors.push(`tarball 包含绝对路径：${file}`);
}
const result = {
  valid: errors.length === 0,
  package: report.name,
  version: report.version,
  filename: report.filename,
  entryCount: files.length,
  unpackedSize: report.unpackedSize,
  errors,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
