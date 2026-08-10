import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  constants as fsConstants,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'requirements-refiner';
export const SKILL_NAME = 'requirements-refiner';
export const PLUGIN_NAME = 'requirements-refiner';
export const MARKETPLACE_NAME = 'requirements-refiner';
export const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const DISTRIBUTION_FILENAME = '.distribution.json';
const LEGACY_MARKETPLACE_NAME = 'requirements-refiner-npm';
const LEGACY_MARKETPLACE_STATE_FILENAME = '.requirements-refiner-installer.json';
const LEGACY_STANDALONE_STATE_FILENAME = 'installer-state.json';
const DISTRIBUTION_SCHEMA_VERSION = 3;
const LEGACY_STANDALONE_SCHEMA_VERSION = 2;
const MINIMUM_NODE_MAJOR = 20;

export class InstallerError extends Error {
  constructor(message, code = 'INSTALLER_ERROR', details = undefined) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    this.details = details;
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function executable(target) {
  try {
    await access(target, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new InstallerError(`无法读取 JSON：${target}`, 'INVALID_JSON', { cause: error.message });
  }
}

async function writeTextAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  }
}

async function writeJsonAtomic(target, value) {
  await writeTextAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function commandFor(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

export function resolveInstallerPaths({
  agentsHome,
  codexHome,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const resolvedHome = path.resolve(home);
  const resolvedCodexHome = path.resolve(codexHome || env.CODEX_HOME || path.join(resolvedHome, '.codex'));
  const resolvedAgentsHome = path.resolve(agentsHome || path.join(resolvedHome, '.agents'));
  const installBase = path.join(resolvedCodexHome, PACKAGE_NAME);
  const marketplaceRoot = path.join(installBase, 'marketplace');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', PLUGIN_NAME);
  const legacyStandaloneStateRoot = path.join(resolvedAgentsHome, `.${PACKAGE_NAME}`);
  const legacyStandaloneSkillDir = path.join(resolvedAgentsHome, 'skills', SKILL_NAME);
  const legacyMarketplaceRoot = path.join(resolvedCodexHome, 'marketplaces', LEGACY_MARKETPLACE_NAME);
  return {
    home: resolvedHome,
    codexHome: resolvedCodexHome,
    agentsHome: resolvedAgentsHome,
    installBase,
    marketplaceRoot,
    marketplaceFile: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    distributionFile: path.join(marketplaceRoot, DISTRIBUTION_FILENAME),
    pluginRoot,
    pluginManifest: path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    installedSkillDir: path.join(pluginRoot, 'skills', SKILL_NAME),
    legacyStandaloneStateRoot,
    legacyStandaloneStateFile: path.join(legacyStandaloneStateRoot, LEGACY_STANDALONE_STATE_FILENAME),
    legacyStandaloneSkillDir,
    legacyMarketplaceRoot,
    legacyMarketplaceStateFile: path.join(legacyMarketplaceRoot, LEGACY_MARKETPLACE_STATE_FILENAME),
  };
}

export function packageRootDirectory() {
  return fileURLToPath(new URL('../', import.meta.url));
}

async function packageVersion(sourceRoot = packageRootDirectory()) {
  return JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version;
}

async function collectDirectoryEntries(root, current = root, target = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      target.push({ type: 'directory', relative, absolute });
      await collectDirectoryEntries(root, absolute, target);
    } else if (entry.isFile()) {
      target.push({ type: 'file', relative, absolute });
    } else if (entry.isSymbolicLink()) {
      target.push({ type: 'symlink', relative, absolute });
    }
  }
  return target;
}

export async function hashDirectory(root) {
  if (!(await exists(root))) return null;
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new InstallerError(`路径不是普通目录：${root}`, 'INVALID_DIRECTORY');
  }
  const hash = createHash('sha256');
  for (const entry of await collectDirectoryEntries(root)) {
    hash.update(`${entry.type}\0${entry.relative}\0`, 'utf8');
    if (entry.type === 'file') hash.update(await readFile(entry.absolute));
    else if (entry.type === 'symlink') hash.update(await readlink(entry.absolute), 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function hashFile(target) {
  if (!(await exists(target))) return null;
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

function preflight(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new InstallerError(
      `需要 Node.js ${MINIMUM_NODE_MAJOR} 或更高版本，当前为 ${nodeVersion}`,
      'NODE_VERSION_UNSUPPORTED',
    );
  }
  return { node: nodeVersion };
}

export function createMarketplace() {
  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Requirements Refiner' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Productivity',
      },
    ],
  };
}

async function assertDistributionSource(sourceRoot, version) {
  const required = [
    path.join(sourceRoot, 'package.json'),
    path.join(sourceRoot, '.codex-plugin', 'plugin.json'),
    path.join(sourceRoot, 'skills', SKILL_NAME, 'SKILL.md'),
  ];
  for (const target of required) {
    if (!(await exists(target))) {
      throw new InstallerError(`npm 包缺少 Plugin 发布文件：${target}`, 'INVALID_PACKAGE');
    }
  }
  const manifest = await readJson(path.join(sourceRoot, '.codex-plugin', 'plugin.json'));
  if (manifest?.name !== PLUGIN_NAME || manifest?.version !== version) {
    throw new InstallerError('package.json 与 Plugin 清单名称或版本不一致', 'INVALID_PACKAGE');
  }
}

function isManagedDistribution(state, paths) {
  return Boolean(
    state
      && state.schemaVersion === DISTRIBUTION_SCHEMA_VERSION
      && state.managedBy === PACKAGE_NAME
      && state.marketplaceName === MARKETPLACE_NAME
      && state.pluginName === PLUGIN_NAME
      && path.resolve(state.marketplaceRoot || '') === paths.marketplaceRoot,
  );
}

function assertSafeMarketplaceTarget(paths) {
  const expected = path.join(paths.codexHome, PACKAGE_NAME, 'marketplace');
  if (paths.marketplaceRoot !== expected || paths.marketplaceRoot === paths.codexHome) {
    throw new InstallerError(`拒绝操作非预期 Marketplace：${paths.marketplaceRoot}`, 'UNSAFE_TARGET');
  }
}

async function inspectCurrentDistribution(paths, { force = false } = {}) {
  if (!(await exists(paths.marketplaceRoot))) return { state: null, pluginHash: null, marketplaceHash: null };
  const info = await lstat(paths.marketplaceRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new InstallerError(`Marketplace 目标不是普通目录：${paths.marketplaceRoot}`, 'UNMANAGED_DISTRIBUTION');
  }
  const state = await readJson(paths.distributionFile, null);
  if (!isManagedDistribution(state, paths)) {
    throw new InstallerError(
      `目录已存在但不属于本安装器：${paths.marketplaceRoot}`,
      'UNMANAGED_DISTRIBUTION',
    );
  }
  const pluginHash = await hashDirectory(paths.pluginRoot);
  const marketplaceHash = await hashFile(paths.marketplaceFile);
  const modified = state.pluginHash !== pluginHash || state.marketplaceHash !== marketplaceHash;
  if (modified && !force) {
    throw new InstallerError(
      '已安装 Plugin 存在本地修改；请先备份修改，或明确使用 --force 覆盖',
      'DISTRIBUTION_MODIFIED',
    );
  }
  return { state, pluginHash, marketplaceHash, modified };
}

async function buildDistributionStage(sourceRoot, version, paths, previousState) {
  await mkdir(paths.installBase, { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const stage = path.join(paths.installBase, `.marketplace-staging-${token}`);
  const stagePluginRoot = path.join(stage, 'plugins', PLUGIN_NAME);
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, '.agents', 'plugins'), { recursive: true });
  await mkdir(stagePluginRoot, { recursive: true });
  try {
    await cp(path.join(sourceRoot, '.codex-plugin'), path.join(stagePluginRoot, '.codex-plugin'), {
      recursive: true,
      preserveTimestamps: true,
    });
    await cp(path.join(sourceRoot, 'skills'), path.join(stagePluginRoot, 'skills'), {
      recursive: true,
      preserveTimestamps: true,
    });
    const marketplaceFile = path.join(stage, '.agents', 'plugins', 'marketplace.json');
    await writeJsonAtomic(marketplaceFile, createMarketplace());
    const pluginHash = await hashDirectory(stagePluginRoot);
    const marketplaceHash = await hashFile(marketplaceFile);
    const now = new Date().toISOString();
    await writeJsonAtomic(path.join(stage, DISTRIBUTION_FILENAME), {
      schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
      managedBy: PACKAGE_NAME,
      packageName: PACKAGE_NAME,
      packageVersion: version,
      marketplaceName: MARKETPLACE_NAME,
      pluginName: PLUGIN_NAME,
      marketplaceRoot: paths.marketplaceRoot,
      pluginHash,
      marketplaceHash,
      installedAt: previousState?.installedAt || now,
      updatedAt: now,
    });
    return { stage, pluginHash, marketplaceHash };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function prepareDistribution(sourceRoot, version, paths, { force = false } = {}) {
  assertSafeMarketplaceTarget(paths);
  const current = await inspectCurrentDistribution(paths, { force });
  const staged = await buildDistributionStage(sourceRoot, version, paths, current.state);
  if (
    current.state?.packageVersion === version
    && current.pluginHash === staged.pluginHash
    && current.marketplaceHash === staged.marketplaceHash
  ) {
    await rm(staged.stage, { recursive: true, force: true });
    return {
      changed: false,
      pluginHash: current.pluginHash,
      previousVersion: current.state?.packageVersion ?? null,
      commit: async () => {},
      rollback: async () => {},
    };
  }

  const backup = path.join(paths.installBase, `.marketplace-backup-${process.pid}-${Date.now()}`);
  const hadPrevious = await exists(paths.marketplaceRoot);
  let previousMoved = false;
  try {
    if (hadPrevious) {
      await rename(paths.marketplaceRoot, backup);
      previousMoved = true;
    }
    await rename(staged.stage, paths.marketplaceRoot);
  } catch (error) {
    await rm(staged.stage, { recursive: true, force: true });
    if (previousMoved && !(await exists(paths.marketplaceRoot))) await rename(backup, paths.marketplaceRoot);
    throw new InstallerError(`无法安装稳定 Plugin 文件：${error.message}`, 'DISTRIBUTION_INSTALL_FAILED');
  }

  let settled = false;
  return {
    changed: true,
    pluginHash: staged.pluginHash,
    previousVersion: current.state?.packageVersion ?? null,
    commit: async () => {
      if (settled) return;
      if (previousMoved) await rm(backup, { recursive: true, force: true }).catch(() => {});
      settled = true;
    },
    rollback: async () => {
      if (settled) return;
      settled = true;
      await rm(paths.marketplaceRoot, { recursive: true, force: true });
      if (previousMoved) await rename(backup, paths.marketplaceRoot);
    },
  };
}

export function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      reject(new InstallerError(`无法执行 ${file}：${error.message}`, 'COMMAND_NOT_FOUND', { file, args }));
    });
    child.once('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr, file, args };
      if (result.code === 0 || options.allowFailure) resolve(result);
      else reject(new InstallerError(`${file} 执行失败`, 'COMMAND_FAILED', result));
    });
  });
}

function dependencies(overrides = {}) {
  return {
    runner: overrides.runner ?? runProcess,
    accessExecutable: overrides.accessExecutable ?? executable,
    readDirectory: overrides.readDirectory ?? readdir,
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    home: overrides.home ?? os.homedir(),
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    packageVersion: overrides.packageVersion,
    sourceRoot: overrides.sourceRoot ?? packageRootDirectory(),
  };
}

async function extensionCodexCandidates(home, deps) {
  const roots = [
    '.vscode/extensions',
    '.vscode-insiders/extensions',
    '.cursor/extensions',
    '.windsurf/extensions',
    '.vscode-oss/extensions',
  ].map((relative) => path.join(home, relative));
  const executableName = commandFor('codex', deps.platform);
  const candidates = [];
  for (const root of roots) {
    let extensions;
    try {
      extensions = await deps.readDirectory(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = extensions
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    for (const extension of versions) {
      const binRoot = path.join(root, extension.name, 'bin');
      candidates.push(path.join(binRoot, executableName));
      try {
        const platformDirectories = await deps.readDirectory(binRoot, { withFileTypes: true });
        for (const directory of platformDirectories) {
          if (directory.isDirectory()) candidates.push(path.join(binRoot, directory.name, executableName));
        }
      } catch {
        // The extension may be incomplete; keep checking other versions and IDEs.
      }
    }
  }
  return candidates;
}

export async function resolveCodexCommand(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const home = deps.home;
  const executableName = commandFor('codex', deps.platform);
  const pathCandidates = String(deps.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  const appCandidates = deps.platform === 'darwin'
    ? [
        '/Applications/Codex.app/Contents/Resources/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
        path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
      ]
    : [];
  const candidates = [
    options.codexBin,
    deps.env.CODEX_CLI_PATH,
    ...pathCandidates,
    ...await extensionCodexCandidates(home, deps),
    ...appCandidates,
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))]) {
    if (await deps.accessExecutable(candidate)) return candidate;
  }
  throw new InstallerError(
    [
      '未找到 Codex CLI。',
      '请先安装 Codex Desktop、Codex VS Code 扩展，或 Codex CLI。',
      '如果安装在自定义位置，请使用 --codex-bin 或设置 CODEX_CLI_PATH。',
    ].join('\n'),
    'CODEX_NOT_FOUND',
  );
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(String(result?.stdout ?? result ?? '').trim() || '{}');
  } catch {
    throw new InstallerError(`无法解析 ${label}，请升级 Codex 后重试`, 'INVALID_CODEX_OUTPUT');
  }
}

async function runChecked(deps, codex, args, { allowFailure = false } = {}) {
  return deps.runner(codex, args, { env: deps.env, cwd: undefined, allowFailure });
}

async function listMarketplaces(deps, codex) {
  const result = await runChecked(deps, codex, ['plugin', 'marketplace', 'list', '--json']);
  return parseJsonOutput(result, 'Codex Marketplace 列表').marketplaces ?? [];
}

async function listPlugins(deps, codex) {
  const result = await runChecked(deps, codex, ['plugin', 'list', '--json']);
  const parsed = parseJsonOutput(result, 'Codex Plugin 列表');
  return parsed.installed ?? parsed.plugins ?? [];
}

function pluginEntry(items, marketplaceName = MARKETPLACE_NAME) {
  return items.find((item) => item.name === PLUGIN_NAME && item.marketplaceName === marketplaceName) ?? null;
}

async function registerPlugin(deps, codex, paths, version) {
  const marketplaces = await listMarketplaces(deps, codex);
  const configured = marketplaces.find((item) => item.name === MARKETPLACE_NAME) ?? null;
  const configuredRoot = configured?.root || configured?.marketplaceSource?.source;
  const correctRoot = configuredRoot && path.resolve(configuredRoot) === paths.marketplaceRoot;
  let marketplaceAdded = false;
  let marketplaceReplaced = false;
  let previousMarketplaceRoot = null;
  try {
    if (configured && !correctRoot) {
      previousMarketplaceRoot = configuredRoot || null;
      await runChecked(deps, codex, ['plugin', 'remove', PLUGIN_SPEC, '--json'], { allowFailure: true });
      await runChecked(deps, codex, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
      marketplaceReplaced = true;
    }
    if (!configured || marketplaceReplaced) {
      await runChecked(deps, codex, ['plugin', 'marketplace', 'add', paths.marketplaceRoot, '--json']);
      marketplaceAdded = true;
    }
    await runChecked(deps, codex, ['plugin', 'add', PLUGIN_SPEC, '--json']);
    const installed = pluginEntry(await listPlugins(deps, codex));
    if (!installed || (installed.version && installed.version !== version)) {
      throw new InstallerError(
        `Plugin 安装校验失败：期望 ${version}，实际 ${installed?.version ?? '未安装'}`,
        'INSTALL_VERIFICATION_FAILED',
      );
    }
    return {
      marketplaceAdded,
      marketplaceReplaced,
      previousMarketplaceRoot,
      installedVersion: installed.version || version,
    };
  } catch (error) {
    await runChecked(
      deps,
      codex,
      ['plugin', 'remove', PLUGIN_SPEC, '--json'],
      { allowFailure: true },
    ).catch(() => {});
    if (marketplaceAdded || marketplaceReplaced) {
      await runChecked(
        deps,
        codex,
        ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json'],
        { allowFailure: true },
      ).catch(() => {});
    }
    if (previousMarketplaceRoot) {
      await runChecked(
        deps,
        codex,
        ['plugin', 'marketplace', 'add', previousMarketplaceRoot, '--json'],
        { allowFailure: true },
      ).catch(() => {});
    }
    if (error && typeof error === 'object') error.marketplaceRestored = Boolean(previousMarketplaceRoot);
    throw error;
  }
}

function isLegacyStandaloneState(state, paths) {
  return Boolean(
    state
      && state.schemaVersion === LEGACY_STANDALONE_SCHEMA_VERSION
      && [PACKAGE_NAME, '@zhiyi/requirements-refiner'].includes(state.managedBy)
      && state.installMode === 'standalone-skill'
      && state.skillName === SKILL_NAME
      && path.resolve(state.skillDirectory || '') === paths.legacyStandaloneSkillDir,
  );
}

async function removeLegacyStandaloneStateRoot(paths) {
  await rm(paths.legacyStandaloneStateFile, { force: true });
  try {
    const entries = await readdir(paths.legacyStandaloneStateRoot);
    if (entries.length === 0) await rm(paths.legacyStandaloneStateRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function retireLegacyStandalone(paths) {
  const state = await readJson(paths.legacyStandaloneStateFile, null);
  const skillExists = await exists(paths.legacyStandaloneSkillDir);
  if (!state && !skillExists) return { detected: false, retired: false, warning: '' };
  if (!isLegacyStandaloneState(state, paths)) {
    return {
      detected: true,
      retired: false,
      warning: `检测到同名独立 Skill，但无法确认由本安装器创建，已保留：${paths.legacyStandaloneSkillDir}`,
    };
  }
  let backupPath = null;
  if (skillExists) {
    const currentHash = await hashDirectory(paths.legacyStandaloneSkillDir);
    if (state.contentHash && currentHash !== state.contentHash) {
      backupPath = `${paths.legacyStandaloneSkillDir}.backup-${Date.now()}`;
      await rename(paths.legacyStandaloneSkillDir, backupPath);
    } else {
      await rm(paths.legacyStandaloneSkillDir, { recursive: true, force: true });
    }
  }
  await removeLegacyStandaloneStateRoot(paths);
  return {
    detected: true,
    retired: true,
    backupPath,
    warning: backupPath ? `旧独立 Skill 有本地修改，已备份到 ${backupPath}` : '',
  };
}

function isLegacyMarketplaceState(state, paths) {
  return Boolean(
    state
      && [PACKAGE_NAME, '@zhiyi/requirements-refiner'].includes(state.managedBy)
      && state.pluginName === PLUGIN_NAME
      && state.marketplaceName === LEGACY_MARKETPLACE_NAME
      && path.resolve(state.marketplaceRoot || '') === paths.legacyMarketplaceRoot,
  );
}

async function retireLegacyMarketplace(deps, codex, paths) {
  const state = await readJson(paths.legacyMarketplaceStateFile, null);
  const marketplaces = await listMarketplaces(deps, codex);
  const configured = marketplaces.find((item) => item.name === LEGACY_MARKETPLACE_NAME) ?? null;
  const configuredRoot = configured?.root || configured?.marketplaceSource?.source;
  const ownedConfiguration = configuredRoot && path.resolve(configuredRoot) === paths.legacyMarketplaceRoot;
  if (!state && !ownedConfiguration) return { detected: false, retired: false, warning: '' };
  if (state && !isLegacyMarketplaceState(state, paths)) {
    return {
      detected: true,
      retired: false,
      warning: `检测到旧 Marketplace，但状态不属于本安装器：${paths.legacyMarketplaceRoot}`,
    };
  }
  if (configured && !ownedConfiguration) {
    return {
      detected: true,
      retired: false,
      warning: `旧 Marketplace 名称已指向其他目录，未自动移除：${configuredRoot}`,
    };
  }
  await runChecked(
    deps,
    codex,
    ['plugin', 'remove', `${PLUGIN_NAME}@${LEGACY_MARKETPLACE_NAME}`, '--json'],
    { allowFailure: true },
  );
  if (configured) {
    await runChecked(deps, codex, ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE_NAME, '--json']);
  }
  if (state && await exists(paths.legacyMarketplaceRoot)) {
    await rm(paths.legacyMarketplaceRoot, { recursive: true, force: true });
  }
  return { detected: true, retired: true, warning: '' };
}

async function runMigrations(deps, codex, paths) {
  const warnings = [];
  const standalone = await retireLegacyStandalone(paths);
  if (standalone.warning) warnings.push(standalone.warning);
  let marketplace;
  try {
    marketplace = await retireLegacyMarketplace(deps, codex, paths);
    if (marketplace.warning) warnings.push(marketplace.warning);
  } catch (error) {
    marketplace = { detected: true, retired: false, warning: error.message };
    warnings.push(`旧 Marketplace 清理失败：${error.message}`);
  }
  return { standalone, marketplace, warnings };
}

export async function installOrUpdate(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion(deps.sourceRoot);
  const paths = resolveInstallerPaths({
    agentsHome: options.agentsHome,
    codexHome: options.codexHome,
    env: deps.env,
    home: deps.home,
  });
  const runtime = preflight(deps.nodeVersion);
  await assertDistributionSource(deps.sourceRoot, version);
  const codex = await resolveCodexCommand(options, deps);
  const transaction = await prepareDistribution(deps.sourceRoot, version, paths, { force: options.force });
  try {
    const registration = await registerPlugin(deps, codex, paths, version);
    await transaction.commit();
    const migration = await runMigrations(deps, codex, paths);
    const changed = transaction.changed
      || registration.marketplaceAdded
      || registration.marketplaceReplaced
      || migration.standalone.retired
      || migration.marketplace.retired;
    return {
      ok: true,
      command: options.command ?? 'install',
      changed,
      alreadyInstalled: !changed,
      version,
      codex,
      installMode: 'stable-marketplace-plugin',
      paths,
      runtime,
      registration,
      migration,
    };
  } catch (error) {
    await transaction.rollback();
    if (transaction.changed && transaction.previousVersion && !error?.marketplaceRestored) {
      await registerPlugin(deps, codex, paths, transaction.previousVersion).catch(() => {});
    }
    throw error;
  }
}

export async function uninstall(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const paths = resolveInstallerPaths({
    agentsHome: options.agentsHome,
    codexHome: options.codexHome,
    env: deps.env,
    home: deps.home,
  });
  const runtime = preflight(deps.nodeVersion);
  const distributionExists = await exists(paths.marketplaceRoot);
  const legacyStandaloneExists = await exists(paths.legacyStandaloneStateFile);
  const legacyMarketplaceExists = await exists(paths.legacyMarketplaceStateFile);
  if (!distributionExists && !legacyStandaloneExists && !legacyMarketplaceExists) {
    return { ok: true, command: 'uninstall', changed: false, alreadyRemoved: true, paths, runtime };
  }

  let codex = null;
  if (distributionExists || legacyMarketplaceExists) codex = await resolveCodexCommand(options, deps);
  if (distributionExists) {
    await inspectCurrentDistribution(paths, { force: options.force });
    const marketplaces = await listMarketplaces(deps, codex);
    const configured = marketplaces.find((item) => item.name === MARKETPLACE_NAME) ?? null;
    const configuredRoot = configured?.root || configured?.marketplaceSource?.source;
    if (configured && path.resolve(configuredRoot || '') !== paths.marketplaceRoot) {
      throw new InstallerError(
        `Marketplace ${MARKETPLACE_NAME} 已指向其他目录，拒绝卸载：${configuredRoot}`,
        'MARKETPLACE_CONFLICT',
      );
    }
    await runChecked(deps, codex, ['plugin', 'remove', PLUGIN_SPEC, '--json'], { allowFailure: true });
    if (configured) {
      await runChecked(deps, codex, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
    }
    assertSafeMarketplaceTarget(paths);
    await rm(paths.marketplaceRoot, { recursive: true, force: true });
    try {
      const entries = await readdir(paths.installBase);
      if (entries.length === 0) await rm(paths.installBase, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const standalone = await retireLegacyStandalone(paths);
  const legacyMarketplace = codex
    ? await retireLegacyMarketplace(deps, codex, paths)
    : { detected: false, retired: false, warning: '' };
  return {
    ok: true,
    command: 'uninstall',
    changed: true,
    codex,
    paths,
    runtime,
    migration: { standalone, marketplace: legacyMarketplace },
  };
}

export async function doctor(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion(deps.sourceRoot);
  const paths = resolveInstallerPaths({
    agentsHome: options.agentsHome,
    codexHome: options.codexHome,
    env: deps.env,
    home: deps.home,
  });
  const checks = [];
  const warnings = [];
  const major = Number.parseInt(String(deps.nodeVersion).split('.')[0], 10);
  checks.push({ name: 'node', ok: major >= MINIMUM_NODE_MAJOR, detail: deps.nodeVersion });
  let codex = null;
  try {
    codex = await resolveCodexCommand(options, deps);
    checks.push({ name: 'codex-cli', ok: true, detail: codex });
  } catch (error) {
    checks.push({ name: 'codex-cli', ok: false, detail: error.message });
  }
  const state = await readJson(paths.distributionFile, null);
  checks.push({
    name: 'distribution-state',
    ok: isManagedDistribution(state, paths),
    detail: state ? `version ${state.packageVersion ?? 'unknown'}` : 'not installed',
  });
  const skillMd = path.join(paths.installedSkillDir, 'SKILL.md');
  checks.push({ name: 'plugin-skill', ok: await exists(skillMd), detail: skillMd });
  let integrity = false;
  try {
    integrity = Boolean(
      state?.pluginHash
      && state.pluginHash === await hashDirectory(paths.pluginRoot)
      && state.marketplaceHash === await hashFile(paths.marketplaceFile),
    );
  } catch {
    integrity = false;
  }
  checks.push({ name: 'distribution-integrity', ok: integrity, detail: integrity ? 'unchanged' : 'missing or modified' });
  checks.push({
    name: 'installed-version',
    ok: state?.packageVersion === version,
    detail: state ? `${state.packageVersion ?? 'unknown'} / package ${version}` : `package ${version}`,
  });
  if (codex) {
    try {
      const marketplaces = await listMarketplaces(deps, codex);
      const configured = marketplaces.find((item) => item.name === MARKETPLACE_NAME) ?? null;
      const configuredRoot = configured?.root || configured?.marketplaceSource?.source;
      checks.push({
        name: 'marketplace-registration',
        ok: Boolean(configuredRoot && path.resolve(configuredRoot) === paths.marketplaceRoot),
        detail: configuredRoot || 'not registered',
      });
      const installed = pluginEntry(await listPlugins(deps, codex));
      checks.push({
        name: 'plugin-registration',
        ok: Boolean(installed && (!installed.version || installed.version === version)),
        detail: installed?.version || (installed ? 'installed' : 'not installed'),
      });
    } catch (error) {
      checks.push({ name: 'codex-registration', ok: false, detail: error.message });
    }
  }
  if (await exists(paths.legacyStandaloneStateFile)) warnings.push('检测到 0.1.2 独立 Skill，运行 update 可迁移清理');
  if (await exists(paths.legacyMarketplaceStateFile)) warnings.push('检测到 0.1.1 或更早版本 Marketplace，运行 update 可迁移清理');
  return {
    ok: checks.every((item) => item.ok),
    command: 'doctor',
    version,
    installMode: 'stable-marketplace-plugin',
    supportedSurfaces: ['desktop', 'cli', 'vscode-ide-extension'],
    codex,
    paths,
    checks,
    warnings,
    note: 'MCP 工具能力需要在 Codex 会话中使用“检查需求整理环境”进行检测。',
  };
}

export function parseArguments(argv) {
  const args = [...argv];
  const parsed = {
    command: 'install',
    yes: false,
    force: false,
    dryRun: false,
    json: false,
    agentsHome: '',
    codexHome: '',
    codexBin: '',
    help: false,
    version: false,
  };
  const commands = new Set(['install', 'update', 'doctor', 'uninstall']);
  if (args[0] && !args[0].startsWith('-')) {
    if (!commands.has(args[0])) throw new InstallerError(`未知命令：${args[0]}`, 'INVALID_ARGUMENT');
    parsed.command = args.shift();
  }
  const takeValue = (name) => {
    const value = args.shift();
    if (!value) throw new InstallerError(`${name} 缺少路径`, 'INVALID_ARGUMENT');
    return value;
  };
  while (args.length > 0) {
    const current = args.shift();
    if (current === '--yes' || current === '-y') parsed.yes = true;
    else if (current === '--force') parsed.force = true;
    else if (current === '--dry-run') parsed.dryRun = true;
    else if (current === '--json') parsed.json = true;
    else if (current === '--help' || current === '-h') parsed.help = true;
    else if (current === '--version' || current === '-v') parsed.version = true;
    else if (current === '--agents-home') parsed.agentsHome = takeValue('--agents-home');
    else if (current === '--codex-home') parsed.codexHome = takeValue('--codex-home');
    else if (current === '--codex-bin') parsed.codexBin = takeValue('--codex-bin');
    else throw new InstallerError(`未知参数：${current}`, 'INVALID_ARGUMENT');
  }
  if (parsed.command === 'doctor' && parsed.dryRun) {
    throw new InstallerError('doctor 不需要 --dry-run', 'INVALID_ARGUMENT');
  }
  return parsed;
}

export function helpText() {
  return `requirements-refiner [install|update|doctor|uninstall] [options]\n\n` +
    `默认命令：install（安装 Codex Plugin）\n\n` +
    `选项：\n` +
    `  -y, --yes              跳过修改前确认\n` +
    `      --force            覆盖受管 Plugin 中的本地修改\n` +
    `      --dry-run          只检查并展示操作\n` +
    `      --json             输出 JSON\n` +
    `      --codex-home PATH  指定 Codex Home（默认 ~/.codex）\n` +
    `      --codex-bin PATH   指定 Codex CLI 路径\n` +
    `      --agents-home PATH 指定旧独立 Skill 所在 .agents 根目录\n` +
    `  -v, --version          显示版本\n` +
    `  -h, --help             显示帮助\n`;
}

function preview(command, version, paths) {
  if (command === 'uninstall') {
    return {
      command,
      version,
      marketplaceRoot: paths.marketplaceRoot,
      actions: [
        `移除 Plugin ${PLUGIN_SPEC}`,
        `移除 Marketplace ${MARKETPLACE_NAME}`,
        `删除受管目录 ${paths.marketplaceRoot}`,
        '保留所有项目需求文档和 UI 缓存',
      ],
    };
  }
  return {
    command,
    version,
    marketplaceRoot: paths.marketplaceRoot,
    actions: [
      `安装稳定 Plugin 到 ${paths.marketplaceRoot}`,
      '自动发现 Codex Desktop 或 VS Code Codex 扩展内置 CLI',
      `注册并安装 ${PLUGIN_SPEC}`,
      '迁移旧版独立 Skill 和 Marketplace，避免重复触发',
    ],
  };
}

async function confirm(message, input = process.stdin, output = process.stderr) {
  const reader = createInterface({ input, output });
  try {
    const answer = (await reader.question(`${message} [y/N] `)).trim().toLocaleLowerCase();
    return ['y', 'yes', '是'].includes(answer);
  } finally {
    reader.close();
  }
}

function humanPreview(value) {
  return [
    `准备执行：${value.command}`,
    `版本：${value.version}`,
    `Marketplace：${value.marketplaceRoot}`,
    ...value.actions.map((item) => `- ${item}`),
  ].join('\n');
}

function warningsFrom(result) {
  return [...(result.migration?.warnings ?? []), ...(result.warnings ?? [])].filter(Boolean);
}

function humanResult(result) {
  if (result.command === 'doctor') {
    return [
      result.ok ? '环境检查通过。' : '环境检查发现问题。',
      ...result.checks.map((item) => `- ${item.ok ? '通过' : '失败'} ${item.name}：${item.detail}`),
      ...warningsFrom(result).map((item) => `- 警告：${item}`),
      `- 提示：${result.note}`,
    ].join('\n');
  }
  if (result.alreadyInstalled) return `requirements-refiner ${result.version} 已安装并注册，无需重复操作。`;
  if (result.alreadyRemoved) return 'requirements-refiner 已卸载。';
  const base = result.command === 'uninstall'
    ? '卸载完成。项目需求文档与 UI 缓存未被修改。'
    : `安装完成：requirements-refiner ${result.version}。请完全退出并重新打开 Codex 后使用 $requirements-refiner。`;
  return [base, ...warningsFrom(result).map((item) => `警告：${item}`)].join('\n');
}

export async function runCli(argv, overrides = {}) {
  const parsed = parseArguments(argv);
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion(deps.sourceRoot);
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  if (parsed.help) {
    stdout.write(helpText());
    return { exitCode: 0 };
  }
  if (parsed.version) {
    stdout.write(`${version}\n`);
    return { exitCode: 0 };
  }
  const paths = resolveInstallerPaths({
    agentsHome: parsed.agentsHome,
    codexHome: parsed.codexHome,
    env: deps.env,
    home: deps.home,
  });
  if (parsed.command === 'doctor') {
    const result = await doctor(parsed, { ...deps, packageVersion: version });
    stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${humanResult(result)}\n`);
    return { exitCode: result.ok ? 0 : 1, result };
  }
  const runtime = preflight(deps.nodeVersion);
  const planned = preview(parsed.command, version, paths);
  if (!parsed.json) stderr.write(`${humanPreview(planned)}\n`);
  if (parsed.dryRun) {
    if (parsed.command !== 'uninstall') await assertDistributionSource(deps.sourceRoot, version);
    const result = { ok: true, dryRun: true, ...planned, runtime };
    stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : '演练完成，未修改任何文件或 Codex 配置。\n');
    return { exitCode: 0, result };
  }
  if (!parsed.yes) {
    const accepted = await (overrides.confirm ?? confirm)('确认继续？', overrides.input, stderr);
    if (!accepted) {
      const result = { ok: true, cancelled: true, ...planned };
      stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : '已取消，未执行修改。\n');
      return { exitCode: 0, result };
    }
  }
  const result = parsed.command === 'uninstall'
    ? await uninstall(parsed, { ...deps, packageVersion: version })
    : await installOrUpdate(parsed, { ...deps, packageVersion: version });
  stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${humanResult(result)}\n`);
  return { exitCode: 0, result };
}
