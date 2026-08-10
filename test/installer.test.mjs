import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MARKETPLACE_NAME,
  PACKAGE_NAME,
  PLUGIN_NAME,
  PLUGIN_SPEC,
  commandFor,
  doctor,
  hashDirectory,
  installOrUpdate,
  parseArguments,
  resolveCodexCommand,
  resolveInstallerPaths,
  runCli,
  uninstall,
} from '../lib/installer.mjs';

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'requirements refiner plugin '));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createPackageSource(root, version = '0.1.3', marker = version) {
  const source = path.join(root, `package ${marker}`);
  await mkdir(path.join(source, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(source, 'skills', PLUGIN_NAME, 'references'), { recursive: true });
  await writeFile(
    path.join(source, 'package.json'),
    `${JSON.stringify({ name: PACKAGE_NAME, version })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(source, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: PLUGIN_NAME, version, skills: './skills/' })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(source, 'skills', PLUGIN_NAME, 'SKILL.md'),
    `---\nname: ${PLUGIN_NAME}\ndescription: test\n---\n\n# ${marker}\n`,
    'utf8',
  );
  await writeFile(
    path.join(source, 'skills', PLUGIN_NAME, 'references', 'rules.md'),
    `${marker}\n`,
    'utf8',
  );
  return source;
}

function fakeCodex({ failPluginAdd = false } = {}) {
  const state = {
    marketplaces: new Map(),
    plugins: new Map(),
    calls: [],
    failPluginAdd,
  };
  const runner = async (file, args) => {
    state.calls.push({ file, args: [...args] });
    const joined = args.join(' ');
    if (joined === 'plugin marketplace list --json') {
      return {
        code: 0,
        stdout: JSON.stringify({
          marketplaces: [...state.marketplaces].map(([name, root]) => ({ name, root })),
        }),
        stderr: '',
      };
    }
    if (joined === 'plugin list --json') {
      return {
        code: 0,
        stdout: JSON.stringify({ installed: [...state.plugins.values()] }),
        stderr: '',
      };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      const marketplaceRoot = args[3];
      const manifest = JSON.parse(
        await readFile(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
      );
      state.marketplaces.set(manifest.name, marketplaceRoot);
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      state.marketplaces.delete(args[3]);
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'add') {
      if (state.failPluginAdd) throw new Error('模拟 Plugin 安装失败');
      const [pluginName, marketplaceName] = args[2].split('@');
      const marketplaceRoot = state.marketplaces.get(marketplaceName);
      const plugin = JSON.parse(
        await readFile(
          path.join(marketplaceRoot, 'plugins', pluginName, '.codex-plugin', 'plugin.json'),
          'utf8',
        ),
      );
      state.plugins.set(`${pluginName}@${marketplaceName}`, {
        name: pluginName,
        marketplaceName,
        version: plugin.version,
      });
      return { code: 0, stdout: '{}', stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'remove') {
      state.plugins.delete(args[2]);
      return { code: 0, stdout: '{}', stderr: '' };
    }
    throw new Error(`未模拟命令：${file} ${joined}`);
  };
  return { runner, state };
}

function testContext(root, sourceRoot, version = '0.1.3', fake = fakeCodex()) {
  const home = path.join(root, 'User Home');
  const codexBin = path.join(root, 'fake tools', commandFor('codex', 'darwin'));
  return {
    fake,
    options: {
      codexHome: path.join(home, '.codex'),
      agentsHome: path.join(home, '.agents'),
      codexBin,
    },
    overrides: {
      home,
      platform: 'darwin',
      env: { PATH: '' },
      nodeVersion: '22.14.0',
      packageVersion: version,
      sourceRoot,
      runner: fake.runner,
      accessExecutable: async (candidate) => candidate === codexBin,
    },
  };
}

async function expectMissing(target) {
  await assert.rejects(readFile(target, 'utf8'), (error) => error?.code === 'ENOENT');
}

test('参数解析和默认安装路径统一位于 CODEX_HOME', () => {
  const parsed = parseArguments(['update', '--yes', '--force', '--codex-home', '/tmp/codex']);
  assert.equal(parsed.command, 'update');
  assert.equal(parsed.yes, true);
  assert.equal(parsed.force, true);
  assert.equal(commandFor('codex', 'win32'), 'codex.exe');
  assert.equal(commandFor('codex', 'darwin'), 'codex');
  const paths = resolveInstallerPaths({ home: '/tmp/demo-user' });
  assert.equal(
    paths.marketplaceRoot,
    path.resolve('/tmp/demo-user/.codex/requirements-refiner/marketplace'),
  );
  assert.throws(() => parseArguments(['unknown']), /未知命令/u);
});

test('可发现 VS Code Codex 扩展内置 CLI', async () => {
  await withTempRoot(async (root) => {
    const home = path.join(root, 'home');
    const codex = path.join(
      home,
      '.vscode',
      'extensions',
      'openai.chatgpt-26.900.1-darwin-arm64',
      'bin',
      'macos-aarch64',
      'codex',
    );
    await mkdir(path.dirname(codex), { recursive: true });
    await writeFile(codex, '#!/bin/sh\n', 'utf8');
    await chmod(codex, 0o755);
    const resolved = await resolveCodexCommand({}, {
      home,
      platform: 'darwin',
      env: { PATH: '' },
    });
    assert.equal(resolved, codex);
  });
});

test('安装、重复安装、更新、诊断和卸载形成完整 Plugin 闭环', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root, '0.1.3');
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({
      ...context.options,
      home: context.overrides.home,
    });

    const installed = await installOrUpdate(
      { ...context.options, command: 'install' },
      context.overrides,
    );
    assert.equal(installed.changed, true);
    assert.equal(installed.installMode, 'stable-marketplace-plugin');
    assert.equal(context.fake.state.marketplaces.get(MARKETPLACE_NAME), paths.marketplaceRoot);
    assert.equal(context.fake.state.plugins.get(PLUGIN_SPEC).version, '0.1.3');
    assert.match(await readFile(path.join(paths.installedSkillDir, 'SKILL.md'), 'utf8'), /0\.1\.3/u);
    const distribution = JSON.parse(await readFile(paths.distributionFile, 'utf8'));
    assert.equal(distribution.schemaVersion, 3);
    assert.equal(distribution.packageVersion, '0.1.3');

    const repeated = await installOrUpdate(
      { ...context.options, command: 'install' },
      context.overrides,
    );
    assert.equal(repeated.changed, false);
    assert.equal(repeated.alreadyInstalled, true);

    const updatedSource = await createPackageSource(root, '0.1.4');
    const updatedOverrides = {
      ...context.overrides,
      packageVersion: '0.1.4',
      sourceRoot: updatedSource,
    };
    const updated = await installOrUpdate(
      { ...context.options, command: 'update' },
      updatedOverrides,
    );
    assert.equal(updated.changed, true);
    assert.equal(context.fake.state.plugins.get(PLUGIN_SPEC).version, '0.1.4');

    const report = await doctor(context.options, updatedOverrides);
    assert.equal(report.ok, true);
    assert.equal(report.codex, context.options.codexBin);

    const requirementCache = path.join(
      root,
      'project',
      'docs',
      'requirements',
      '示例',
      '_sources',
      'raw',
      'UI-01',
      'manifest.json',
    );
    await mkdir(path.dirname(requirementCache), { recursive: true });
    await writeFile(requirementCache, '{"status":"complete"}\n', 'utf8');
    const removed = await uninstall(context.options, updatedOverrides);
    assert.equal(removed.changed, true);
    assert.equal(await readFile(requirementCache, 'utf8'), '{"status":"complete"}\n');
    await expectMissing(paths.distributionFile);
    assert.equal(context.fake.state.marketplaces.has(MARKETPLACE_NAME), false);
    assert.equal(context.fake.state.plugins.has(PLUGIN_SPEC), false);

    const repeatedRemove = await uninstall(context.options, updatedOverrides);
    assert.equal(repeatedRemove.alreadyRemoved, true);
  });
});

test('首次安装失败会回滚稳定目录和 Marketplace 注册', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const fake = fakeCodex({ failPluginAdd: true });
    const context = testContext(root, source, '0.1.3', fake);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await assert.rejects(
      installOrUpdate(context.options, context.overrides),
      /模拟 Plugin 安装失败/u,
    );
    await expectMissing(paths.distributionFile);
    assert.equal(fake.state.marketplaces.has(MARKETPLACE_NAME), false);
  });
});

test('更新安装失败会恢复上一版 Plugin 文件', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root, '0.1.3');
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await installOrUpdate(context.options, context.overrides);
    const next = await createPackageSource(root, '0.1.4');
    context.fake.state.failPluginAdd = true;
    await assert.rejects(
      installOrUpdate(
        { ...context.options, command: 'update' },
        { ...context.overrides, packageVersion: '0.1.4', sourceRoot: next },
      ),
      /模拟 Plugin 安装失败/u,
    );
    assert.equal(
      JSON.parse(await readFile(paths.pluginManifest, 'utf8')).version,
      '0.1.3',
    );
  });
});

test('拒绝覆盖非本安装器管理或已被修改的稳定目录', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await mkdir(paths.marketplaceRoot, { recursive: true });
    await writeFile(path.join(paths.marketplaceRoot, 'foreign.txt'), 'keep\n', 'utf8');
    await assert.rejects(
      installOrUpdate(context.options, context.overrides),
      (error) => error?.code === 'UNMANAGED_DISTRIBUTION',
    );
    assert.equal(await readFile(path.join(paths.marketplaceRoot, 'foreign.txt'), 'utf8'), 'keep\n');
  });

  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await installOrUpdate(context.options, context.overrides);
    await writeFile(path.join(paths.pluginRoot, 'local-note.md'), 'changed\n', 'utf8');
    await assert.rejects(
      installOrUpdate({ ...context.options, command: 'update' }, context.overrides),
      (error) => error?.code === 'DISTRIBUTION_MODIFIED',
    );
    await installOrUpdate(
      { ...context.options, command: 'update', force: true },
      context.overrides,
    );
    await expectMissing(path.join(paths.pluginRoot, 'local-note.md'));
  });
});

test('安装成功后迁移 0.1.2 独立 Skill 和更早 Marketplace', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await mkdir(paths.legacyStandaloneSkillDir, { recursive: true });
    await writeFile(path.join(paths.legacyStandaloneSkillDir, 'SKILL.md'), 'legacy\n', 'utf8');
    const legacyHash = await hashDirectory(paths.legacyStandaloneSkillDir);
    await mkdir(path.dirname(paths.legacyStandaloneStateFile), { recursive: true });
    await writeFile(
      paths.legacyStandaloneStateFile,
      `${JSON.stringify({
        schemaVersion: 2,
        managedBy: PACKAGE_NAME,
        installMode: 'standalone-skill',
        skillName: PLUGIN_NAME,
        skillDirectory: paths.legacyStandaloneSkillDir,
        contentHash: legacyHash,
      })}\n`,
      'utf8',
    );
    await mkdir(paths.legacyMarketplaceRoot, { recursive: true });
    await writeFile(
      paths.legacyMarketplaceStateFile,
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: PACKAGE_NAME,
        pluginName: PLUGIN_NAME,
        marketplaceName: 'requirements-refiner-npm',
        marketplaceRoot: paths.legacyMarketplaceRoot,
      })}\n`,
      'utf8',
    );
    context.fake.state.marketplaces.set('requirements-refiner-npm', paths.legacyMarketplaceRoot);
    context.fake.state.plugins.set(`${PLUGIN_NAME}@requirements-refiner-npm`, {
      name: PLUGIN_NAME,
      marketplaceName: 'requirements-refiner-npm',
      version: '0.1.1',
    });

    const result = await installOrUpdate(
      { ...context.options, command: 'update' },
      context.overrides,
    );
    assert.equal(result.migration.standalone.retired, true);
    assert.equal(result.migration.marketplace.retired, true);
    await expectMissing(path.join(paths.legacyStandaloneSkillDir, 'SKILL.md'));
    await expectMissing(paths.legacyMarketplaceStateFile);
    assert.equal(context.fake.state.marketplaces.has('requirements-refiner-npm'), false);
  });
});

test('旧独立 Skill 有本地修改时自动备份而不是删除', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await mkdir(paths.legacyStandaloneSkillDir, { recursive: true });
    await writeFile(path.join(paths.legacyStandaloneSkillDir, 'SKILL.md'), 'original\n', 'utf8');
    const originalHash = await hashDirectory(paths.legacyStandaloneSkillDir);
    await mkdir(path.dirname(paths.legacyStandaloneStateFile), { recursive: true });
    await writeFile(
      paths.legacyStandaloneStateFile,
      `${JSON.stringify({
        schemaVersion: 2,
        managedBy: PACKAGE_NAME,
        installMode: 'standalone-skill',
        skillName: PLUGIN_NAME,
        skillDirectory: paths.legacyStandaloneSkillDir,
        contentHash: originalHash,
      })}\n`,
      'utf8',
    );
    await writeFile(path.join(paths.legacyStandaloneSkillDir, 'note.md'), 'user change\n', 'utf8');
    const result = await installOrUpdate(context.options, context.overrides);
    assert.ok(result.migration.standalone.backupPath);
    assert.equal(
      await readFile(path.join(result.migration.standalone.backupPath, 'note.md'), 'utf8'),
      'user change\n',
    );
  });
});

test('找不到任何 Codex 可执行文件时不写入稳定目录', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    context.overrides.accessExecutable = async () => false;
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    await assert.rejects(
      installOrUpdate(context.options, context.overrides),
      (error) => error?.code === 'CODEX_NOT_FOUND',
    );
    await expectMissing(paths.distributionFile);
  });
});

test('dry-run 和取消操作不会写入 CODEX_HOME', async () => {
  await withTempRoot(async (root) => {
    const source = await createPackageSource(root);
    const context = testContext(root, source);
    const paths = resolveInstallerPaths({ ...context.options, home: context.overrides.home });
    let output = '';
    const stdout = { write: (value) => { output += value; } };
    const stderr = { write: () => {} };
    const commonArgs = [
      '--codex-home',
      context.options.codexHome,
      '--agents-home',
      context.options.agentsHome,
      '--codex-bin',
      context.options.codexBin,
    ];
    const dryRun = await runCli(
      ['install', '--dry-run', '--json', ...commonArgs],
      { ...context.overrides, stdout, stderr },
    );
    assert.equal(dryRun.result.dryRun, true);
    assert.equal(JSON.parse(output).ok, true);
    await expectMissing(paths.distributionFile);

    output = '';
    const cancelled = await runCli(
      ['install', '--json', ...commonArgs],
      { ...context.overrides, stdout, stderr, confirm: async () => false },
    );
    assert.equal(cancelled.result.cancelled, true);
    await expectMissing(paths.distributionFile);
  });
});
