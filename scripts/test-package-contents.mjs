#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'requirements-refiner-pack-test-'));
const npmCache = path.join(temporaryRoot, 'npm-cache');
const packDestination = path.join(temporaryRoot, 'packed');
const consumer = path.join(temporaryRoot, 'consumer with spaces');
const agentsHome = path.join(temporaryRoot, 'agents home');
const codexHome = path.join(temporaryRoot, 'codex home');
const fakeCodex = path.join(temporaryRoot, 'fake codex');
const fakeCodexState = path.join(temporaryRoot, 'fake-codex-state.json');
await mkdir(npmCache, { recursive: true });
await mkdir(packDestination, { recursive: true });
await writeFile(fakeCodexState, '{"marketplaces":{},"plugins":[]}\n', 'utf8');
await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const statePath = process.env.FAKE_CODEX_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const joined = args.join(' ');
const save = () => writeFileSync(statePath, JSON.stringify(state));
if (joined === 'plugin marketplace list --json') {
  console.log(JSON.stringify({ marketplaces: Object.entries(state.marketplaces).map(([name, root]) => ({ name, root })) }));
} else if (joined === 'plugin list --json') {
  console.log(JSON.stringify({ installed: state.plugins }));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const root = args[3];
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  state.marketplaces[manifest.name] = root;
  save();
  console.log('{}');
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  delete state.marketplaces[args[3]];
  save();
  console.log('{}');
} else if (args[0] === 'plugin' && args[1] === 'add') {
  const [pluginName, marketplaceName] = args[2].split('@');
  const root = state.marketplaces[marketplaceName];
  const plugin = JSON.parse(readFileSync(path.join(root, 'plugins', pluginName, '.codex-plugin', 'plugin.json'), 'utf8'));
  state.plugins = state.plugins.filter((item) => !(item.name === pluginName && item.marketplaceName === marketplaceName));
  state.plugins.push({ name: pluginName, marketplaceName, version: plugin.version });
  save();
  console.log('{}');
} else if (args[0] === 'plugin' && args[1] === 'remove') {
  const [pluginName, marketplaceName] = args[2].split('@');
  state.plugins = state.plugins.filter((item) => !(item.name === pluginName && item.marketplaceName === marketplaceName));
  save();
  console.log('{}');
} else {
  console.error('unsupported fake codex command: ' + joined);
  process.exitCode = 1;
}
`, 'utf8');
await chmod(fakeCodex, 0o755);
let report;
let smoke = { installed: false, diagnosed: false, uninstalled: false };
try {
  const output = execFileSync('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDestination,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  report = JSON.parse(output)[0];
  const tarball = path.join(packDestination, report.filename);
  execFileSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    consumer,
    tarball,
  ], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  const installedRoot = path.join(consumer, 'node_modules', 'requirements-refiner');
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  const installedPlugin = JSON.parse(await readFile(path.join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (installedPackage.version !== installedPlugin.version) {
    throw new Error('打包后 package.json 与 plugin.json 版本不一致');
  }
  const cli = path.join(installedRoot, 'bin', 'requirements-refiner.mjs');
  const runCli = (args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_CODEX_STATE: fakeCodexState },
  }));
  const common = ['--agents-home', agentsHome, '--codex-home', codexHome, '--codex-bin', fakeCodex];
  const installed = runCli(['install', '--yes', ...common]);
  smoke.installed = installed.ok === true
    && Boolean(await readFile(path.join(
      codexHome,
      'requirements-refiner',
      'marketplace',
      'plugins',
      'requirements-refiner',
      'skills',
      'requirements-refiner',
      'SKILL.md',
    ), 'utf8'));
  const diagnosed = runCli(['doctor', ...common]);
  smoke.diagnosed = diagnosed.ok === true;
  const uninstalled = runCli(['uninstall', '--yes', ...common]);
  smoke.uninstalled = uninstalled.ok === true;
  try {
    await readFile(path.join(codexHome, 'requirements-refiner', 'marketplace', '.distribution.json'), 'utf8');
    smoke.uninstalled = false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
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
for (const [name, passed] of Object.entries(smoke)) {
  if (!passed) errors.push(`打包安装冒烟测试失败：${name}`);
}
const result = {
  valid: errors.length === 0,
  package: report.name,
  version: report.version,
  filename: report.filename,
  entryCount: files.length,
  unpackedSize: report.unpackedSize,
  smoke,
  errors,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
