import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  InstallerError,
  MARKETPLACE_NAME,
  PACKAGE_NAME,
  PLUGIN_NAME,
  commandFor,
  doctor,
  installOrUpdate,
  parseArguments,
  resolveInstallerPaths,
  runCli,
  uninstall,
} from '../lib/installer.mjs';

function fakeCodex({ marketplaceFile, failPluginAdd = false } = {}) {
  const state = {
    marketplaceRoot: null,
    installedVersion: null,
    calls: [],
  };
  const runner = async (file, args) => {
    state.calls.push({ file, args: [...args] });
    if (args[0] === '--version') {
      return { code: 0, stdout: file.startsWith('npm') ? '10.9.2\n' : 'codex-cli 1.0.0\n', stderr: '' };
    }
    if (args.join(' ') === 'plugin marketplace list --json') {
      return {
        code: 0,
        stdout: JSON.stringify({
          marketplaces: state.marketplaceRoot
            ? [{ name: MARKETPLACE_NAME, root: state.marketplaceRoot }]
            : [],
        }),
        stderr: '',
      };
    }
    if (args.join(' ') === 'plugin list --json') {
      return {
        code: 0,
        stdout: JSON.stringify({
          installed: state.installedVersion
            ? [{ name: PLUGIN_NAME, marketplaceName: MARKETPLACE_NAME, version: state.installedVersion }]
            : [],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      state.marketplaceRoot = args[3];
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      state.marketplaceRoot = null;
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'add') {
      if (failPluginAdd) throw new InstallerError('模拟安装失败', 'COMMAND_FAILED');
      const manifest = JSON.parse(await readFile(marketplaceFile, 'utf8'));
      state.installedVersion = manifest.plugins[0].source.version;
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'remove') {
      state.installedVersion = null;
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    }
    throw new Error(`未模拟命令：${file} ${args.join(' ')}`);
  };
  return { runner, state };
}

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'requirements refiner installer '));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('参数解析和跨平台命令名称', () => {
  assert.deepEqual(parseArguments([]).command, 'install');
  assert.equal(parseArguments(['update', '--yes', '--codex-home', '/tmp/demo']).yes, true);
  assert.equal(commandFor('codex', 'win32'), 'codex.cmd');
  assert.equal(commandFor('codex', 'darwin'), 'codex');
  assert.throws(() => parseArguments(['unknown']), /未知命令/u);
  assert.throws(() => parseArguments(['doctor', '--dry-run']), /不需要 --dry-run/u);
});

test('安装、重复安装、更新、诊断和卸载形成完整闭环', async () => {
  await withTempRoot(async (root) => {
    const codexHome = path.join(root, 'Codex Home');
    const paths = resolveInstallerPaths({ codexHome });
    const fake = fakeCodex({ marketplaceFile: paths.marketplaceFile });
    const base = { runner: fake.runner, nodeVersion: '22.14.0', packageVersion: '0.1.0' };

    const installed = await installOrUpdate({ codexHome, command: 'install' }, base);
    assert.equal(installed.changed, true);
    assert.equal(fake.state.installedVersion, '0.1.0');
    const marketplace = JSON.parse(await readFile(paths.marketplaceFile, 'utf8'));
    assert.equal(marketplace.plugins[0].source.package, PACKAGE_NAME);
    assert.equal(marketplace.plugins[0].source.version, '0.1.0');
    assert.equal(marketplace.plugins[0].policy.authentication, 'ON_USE');

    const repeated = await installOrUpdate({ codexHome, command: 'install' }, base);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.alreadyInstalled, true);
    assert.equal(fake.state.calls.filter((item) => item.args[0] === 'plugin' && item.args[1] === 'add').length, 1);

    const updated = await installOrUpdate(
      { codexHome, command: 'update' },
      { ...base, packageVersion: '0.2.0' },
    );
    assert.equal(updated.changed, true);
    assert.equal(fake.state.installedVersion, '0.2.0');
    assert.equal(JSON.parse(await readFile(paths.marketplaceFile, 'utf8')).plugins[0].source.version, '0.2.0');

    const report = await doctor({ codexHome }, { ...base, packageVersion: '0.2.0' });
    assert.equal(report.ok, true);

    const projectRequirement = path.join(root, 'project', 'docs', 'requirements', '示例', '_sources', 'raw', 'UI-01', 'manifest.json');
    await mkdir(path.dirname(projectRequirement), { recursive: true });
    await writeFile(projectRequirement, '{"status":"complete"}\n', 'utf8');
    const removed = await uninstall({ codexHome }, { ...base, packageVersion: '0.2.0' });
    assert.equal(removed.changed, true);
    assert.equal(fake.state.installedVersion, null);
    assert.equal(await readFile(projectRequirement, 'utf8'), '{"status":"complete"}\n');
    await assert.rejects(readFile(paths.stateFile, 'utf8'), /ENOENT/u);

    const repeatedRemove = await uninstall({ codexHome }, { ...base, packageVersion: '0.2.0' });
    assert.equal(repeatedRemove.alreadyRemoved, true);
  });
});

test('首次安装失败会回滚 Marketplace 文件和注册', async () => {
  await withTempRoot(async (root) => {
    const codexHome = path.join(root, 'codex');
    const paths = resolveInstallerPaths({ codexHome });
    const fake = fakeCodex({ marketplaceFile: paths.marketplaceFile, failPluginAdd: true });
    await assert.rejects(
      installOrUpdate(
        { codexHome, command: 'install' },
        { runner: fake.runner, nodeVersion: '22.14.0', packageVersion: '0.1.0' },
      ),
      /模拟安装失败/u,
    );
    assert.equal(fake.state.marketplaceRoot, null);
    await assert.rejects(readFile(paths.marketplaceFile, 'utf8'), /ENOENT/u);
  });
});

test('拒绝删除不属于安装器的目录', async () => {
  await withTempRoot(async (root) => {
    const codexHome = path.join(root, 'codex');
    const paths = resolveInstallerPaths({ codexHome });
    await mkdir(paths.marketplaceRoot, { recursive: true });
    const foreignFile = path.join(paths.marketplaceRoot, 'foreign.txt');
    await writeFile(foreignFile, 'keep', 'utf8');
    const fake = fakeCodex({ marketplaceFile: paths.marketplaceFile });
    await assert.rejects(
      uninstall(
        { codexHome },
        { runner: fake.runner, nodeVersion: '22.14.0', packageVersion: '0.1.0' },
      ),
      /不属于本安装器/u,
    );
    assert.equal(await readFile(foreignFile, 'utf8'), 'keep');
  });
});

test('dry-run 和取消操作不会写入用户目录', async () => {
  await withTempRoot(async (root) => {
    const codexHome = path.join(root, 'codex');
    const paths = resolveInstallerPaths({ codexHome });
    const fake = fakeCodex({ marketplaceFile: paths.marketplaceFile });
    let output = '';
    const stdout = { write: (value) => { output += value; } };
    const stderr = { write: () => {} };
    const dryRun = await runCli(
      ['install', '--dry-run', '--json', '--codex-home', codexHome],
      { runner: fake.runner, nodeVersion: '22.14.0', packageVersion: '0.1.0', stdout, stderr },
    );
    assert.equal(dryRun.result.dryRun, true);
    assert.equal(JSON.parse(output).ok, true);
    await assert.rejects(readFile(paths.marketplaceFile, 'utf8'), /ENOENT/u);

    output = '';
    const cancelled = await runCli(
      ['install', '--json', '--codex-home', codexHome],
      {
        runner: fake.runner,
        nodeVersion: '22.14.0',
        packageVersion: '0.1.0',
        stdout,
        stderr,
        confirm: async () => false,
      },
    );
    assert.equal(cancelled.result.cancelled, true);
    await assert.rejects(readFile(paths.marketplaceFile, 'utf8'), /ENOENT/u);
  });
});
