import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'requirements-refiner';
export const PLUGIN_NAME = 'requirements-refiner';
export const MARKETPLACE_NAME = 'requirements-refiner-npm';
export const REGISTRY_URL = 'https://registry.npmjs.org';
export const STATE_FILENAME = '.requirements-refiner-installer.json';
const STATE_SCHEMA_VERSION = 1;
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

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new InstallerError(`无法读取 JSON：${target}`, 'INVALID_JSON', { cause: error.message });
  }
}

async function readText(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
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
  return platform === 'win32' ? `${name}.cmd` : name;
}

export function resolveInstallerPaths({ codexHome, env = process.env, home = os.homedir() } = {}) {
  const resolvedCodexHome = path.resolve(codexHome || env.CODEX_HOME || path.join(home, '.codex'));
  const marketplacesRoot = path.join(resolvedCodexHome, 'marketplaces');
  const marketplaceRoot = path.join(marketplacesRoot, MARKETPLACE_NAME);
  return {
    codexHome: resolvedCodexHome,
    marketplacesRoot,
    marketplaceRoot,
    marketplaceFile: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    stateFile: path.join(marketplaceRoot, STATE_FILENAME),
  };
}

export function createMarketplace(version) {
  return {
    name: MARKETPLACE_NAME,
    interface: {
      displayName: '需求收集与完善',
    },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: {
          source: 'npm',
          package: PACKAGE_NAME,
          version,
          registry: REGISTRY_URL,
        },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_USE',
        },
        category: 'Productivity',
      },
    ],
  };
}

function createState(version, paths, previous = null) {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    managedBy: PACKAGE_NAME,
    pluginName: PLUGIN_NAME,
    marketplaceName: MARKETPLACE_NAME,
    packageName: PACKAGE_NAME,
    installedVersion: version,
    marketplaceRoot: paths.marketplaceRoot,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

function isManagedState(state, paths) {
  return Boolean(
    state
      && state.schemaVersion === STATE_SCHEMA_VERSION
      && state.managedBy === PACKAGE_NAME
      && state.pluginName === PLUGIN_NAME
      && state.marketplaceName === MARKETPLACE_NAME
      && path.resolve(state.marketplaceRoot || '') === paths.marketplaceRoot,
  );
}

function parseJsonOutput(output, label) {
  const text = String(output ?? '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) throw new InstallerError(`${label} 没有返回 JSON`, 'INVALID_COMMAND_OUTPUT', { output: text });
  try {
    return JSON.parse(text.slice(start));
  } catch (error) {
    throw new InstallerError(`${label} 返回了无效 JSON`, 'INVALID_COMMAND_OUTPUT', { cause: error.message });
  }
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
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    home: overrides.home ?? os.homedir(),
    nodeVersion: overrides.nodeVersion ?? process.versions.node,
    packageVersion: overrides.packageVersion,
  };
}

async function packageVersion() {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  return manifest.version;
}

async function runChecked(deps, name, args) {
  return deps.runner(commandFor(name, deps.platform), args, { env: deps.env });
}

async function preflight(deps, { npm = true } = {}) {
  const major = Number.parseInt(String(deps.nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new InstallerError(`需要 Node.js ${MINIMUM_NODE_MAJOR} 或更高版本，当前为 ${deps.nodeVersion}`, 'NODE_VERSION_UNSUPPORTED');
  }
  const result = { node: deps.nodeVersion };
  if (npm) result.npm = (await runChecked(deps, 'npm', ['--version'])).stdout.trim();
  result.codex = (await runChecked(deps, 'codex', ['--version'])).stdout.trim();
  return result;
}

async function listMarketplaces(deps) {
  const result = await runChecked(deps, 'codex', ['plugin', 'marketplace', 'list', '--json']);
  return parseJsonOutput(result.stdout, 'Codex Marketplace 列表').marketplaces ?? [];
}

async function listPlugins(deps) {
  const result = await runChecked(deps, 'codex', ['plugin', 'list', '--json']);
  return parseJsonOutput(result.stdout, 'Codex 插件列表').installed ?? [];
}

function marketplaceEntry(items) {
  return items.find((item) => item.name === MARKETPLACE_NAME) ?? null;
}

function pluginEntry(items) {
  return items.find((item) => item.name === PLUGIN_NAME && item.marketplaceName === MARKETPLACE_NAME) ?? null;
}

function assertMarketplaceOwnership(entry, paths) {
  if (!entry) return;
  const actual = entry.root || entry.marketplaceSource?.source;
  if (!actual || path.resolve(actual) !== paths.marketplaceRoot) {
    throw new InstallerError(
      `Marketplace ${MARKETPLACE_NAME} 已指向其他目录：${actual || '未知'}`,
      'MARKETPLACE_CONFLICT',
    );
  }
}

async function assertDirectoryIsManagedOrEmpty(paths) {
  if (!(await exists(paths.marketplaceRoot))) return null;
  const state = await readJson(paths.stateFile, null);
  if (isManagedState(state, paths)) return state;
  const entries = await readdir(paths.marketplaceRoot);
  if (entries.length === 0) return null;
  throw new InstallerError(
    `目录已存在但不属于本安装器：${paths.marketplaceRoot}`,
    'UNMANAGED_DIRECTORY',
  );
}

function marketplaceHasVersion(manifest, version) {
  const entry = manifest?.plugins?.find((item) => item.name === PLUGIN_NAME);
  return entry?.source?.source === 'npm'
    && entry.source.package === PACKAGE_NAME
    && entry.source.version === version
    && entry.source.registry === REGISTRY_URL;
}

async function bestEffort(deps, name, args) {
  try {
    await runChecked(deps, name, args);
  } catch {
    // Rollback is best-effort; the original failure remains the useful error.
  }
}

export async function installOrUpdate(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion();
  const paths = resolveInstallerPaths({ codexHome: options.codexHome, env: deps.env, home: deps.home });
  const runtime = overrides.runtime ?? await preflight(deps);
  const previousState = await assertDirectoryIsManagedOrEmpty(paths);
  const previousMarketplaceText = await readText(paths.marketplaceFile);
  const previousStateText = await readText(paths.stateFile);
  const marketplaces = await listMarketplaces(deps);
  const plugins = await listPlugins(deps);
  const configuredMarketplace = marketplaceEntry(marketplaces);
  assertMarketplaceOwnership(configuredMarketplace, paths);
  const installedPlugin = pluginEntry(plugins);
  const previousMarketplace = previousMarketplaceText ? JSON.parse(previousMarketplaceText) : null;

  if (
    installedPlugin?.version === version
    && configuredMarketplace
    && marketplaceHasVersion(previousMarketplace, version)
    && isManagedState(previousState, paths)
  ) {
    return {
      ok: true,
      command: options.command ?? 'install',
      changed: false,
      alreadyInstalled: true,
      version,
      paths,
      runtime,
    };
  }

  const marketplace = createMarketplace(version);
  let marketplaceAdded = false;
  let pluginTouched = false;
  try {
    await writeJsonAtomic(paths.marketplaceFile, marketplace);
    if (!configuredMarketplace) {
      await runChecked(deps, 'codex', ['plugin', 'marketplace', 'add', paths.marketplaceRoot, '--json']);
      marketplaceAdded = true;
    }
    await runChecked(deps, 'codex', ['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--json']);
    pluginTouched = true;

    const installed = pluginEntry(await listPlugins(deps));
    if (!installed || installed.version !== version) {
      throw new InstallerError(
        `插件安装后版本校验失败：期望 ${version}，实际 ${installed?.version ?? '未安装'}`,
        'INSTALL_VERIFICATION_FAILED',
      );
    }
    await writeJsonAtomic(paths.stateFile, createState(version, paths, previousState));
    return {
      ok: true,
      command: options.command ?? 'install',
      changed: true,
      version,
      paths,
      runtime,
    };
  } catch (error) {
    if (pluginTouched && !previousState) {
      await bestEffort(deps, 'codex', ['plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--json']);
    }
    if (marketplaceAdded) {
      await bestEffort(deps, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
    }
    if (previousMarketplaceText !== null) await writeTextAtomic(paths.marketplaceFile, previousMarketplaceText);
    if (previousStateText !== null) await writeTextAtomic(paths.stateFile, previousStateText);
    if (previousMarketplaceText === null && previousStateText === null) {
      await rm(paths.marketplaceRoot, { recursive: true, force: true });
    } else if (previousMarketplaceText !== null && previousState) {
      await bestEffort(deps, 'codex', ['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--json']);
    }
    throw error;
  }
}

function assertSafeManagedRoot(paths) {
  const expected = path.join(paths.marketplacesRoot, MARKETPLACE_NAME);
  if (paths.marketplaceRoot !== expected || paths.marketplaceRoot === paths.marketplacesRoot) {
    throw new InstallerError(`拒绝删除非预期目录：${paths.marketplaceRoot}`, 'UNSAFE_DELETE_TARGET');
  }
}

export async function uninstall(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const paths = resolveInstallerPaths({ codexHome: options.codexHome, env: deps.env, home: deps.home });
  const runtime = overrides.runtime ?? await preflight(deps, { npm: false });
  const state = await assertDirectoryIsManagedOrEmpty(paths);
  const marketplaces = await listMarketplaces(deps);
  const plugins = await listPlugins(deps);
  const configuredMarketplace = marketplaceEntry(marketplaces);
  assertMarketplaceOwnership(configuredMarketplace, paths);
  const installedPlugin = pluginEntry(plugins);

  if (!state && !configuredMarketplace && !installedPlugin && !(await exists(paths.marketplaceRoot))) {
    return { ok: true, command: 'uninstall', changed: false, alreadyRemoved: true, paths, runtime };
  }

  if (installedPlugin) {
    await runChecked(deps, 'codex', ['plugin', 'remove', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--json']);
  }
  if (configuredMarketplace) {
    await runChecked(deps, 'codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
  }
  if (await exists(paths.marketplaceRoot)) {
    if (!state) {
      const entries = await readdir(paths.marketplaceRoot);
      if (entries.length > 0) throw new InstallerError('缺少有效安装器状态，拒绝删除目录', 'UNMANAGED_DIRECTORY');
    }
    assertSafeManagedRoot(paths);
    await rm(paths.marketplaceRoot, { recursive: true, force: true });
  }
  return { ok: true, command: 'uninstall', changed: true, paths, runtime };
}

async function safeCheck(name, operation) {
  try {
    const detail = await operation();
    return { name, ok: true, detail };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function doctor(options = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion();
  const paths = resolveInstallerPaths({ codexHome: options.codexHome, env: deps.env, home: deps.home });
  const checks = [];
  const major = Number.parseInt(String(deps.nodeVersion).split('.')[0], 10);
  checks.push({ name: 'node', ok: major >= MINIMUM_NODE_MAJOR, detail: deps.nodeVersion });
  checks.push(await safeCheck('npm', async () => (await runChecked(deps, 'npm', ['--version'])).stdout.trim()));
  checks.push(await safeCheck('codex', async () => (await runChecked(deps, 'codex', ['--version'])).stdout.trim()));

  const state = await readJson(paths.stateFile, null);
  checks.push({
    name: 'installer-state',
    ok: isManagedState(state, paths),
    detail: state ? `version ${state.installedVersion ?? 'unknown'}` : 'not installed',
  });
  const marketplace = await readJson(paths.marketplaceFile, null);
  checks.push({
    name: 'marketplace-file',
    ok: marketplaceHasVersion(marketplace, version),
    detail: marketplace ? marketplace.plugins?.[0]?.source?.version ?? 'invalid' : 'missing',
  });

  checks.push(await safeCheck('marketplace-registration', async () => {
    const entry = marketplaceEntry(await listMarketplaces(deps));
    assertMarketplaceOwnership(entry, paths);
    if (!entry) throw new Error('not configured');
    return entry.root || entry.marketplaceSource?.source;
  }));
  checks.push(await safeCheck('plugin-installation', async () => {
    const entry = pluginEntry(await listPlugins(deps));
    if (!entry) throw new Error('not installed');
    if (entry.version !== version) throw new Error(`installed ${entry.version}, expected ${version}`);
    return entry.version;
  }));

  return {
    ok: checks.every((item) => item.ok),
    command: 'doctor',
    version,
    paths,
    checks,
    note: 'MCP 工具能力需要在 Codex 会话中使用“检查需求整理环境”进行检测。',
  };
}

export function parseArguments(argv) {
  const args = [...argv];
  const parsed = {
    command: 'install',
    yes: false,
    dryRun: false,
    json: false,
    codexHome: '',
    help: false,
    version: false,
  };
  const commands = new Set(['install', 'update', 'doctor', 'uninstall']);
  if (args[0] && !args[0].startsWith('-')) {
    if (!commands.has(args[0])) throw new InstallerError(`未知命令：${args[0]}`, 'INVALID_ARGUMENT');
    parsed.command = args.shift();
  }
  while (args.length > 0) {
    const current = args.shift();
    if (current === '--yes' || current === '-y') parsed.yes = true;
    else if (current === '--dry-run') parsed.dryRun = true;
    else if (current === '--json') parsed.json = true;
    else if (current === '--help' || current === '-h') parsed.help = true;
    else if (current === '--version' || current === '-v') parsed.version = true;
    else if (current === '--codex-home') {
      const value = args.shift();
      if (!value) throw new InstallerError('--codex-home 缺少路径', 'INVALID_ARGUMENT');
      parsed.codexHome = value;
    } else throw new InstallerError(`未知参数：${current}`, 'INVALID_ARGUMENT');
  }
  if (parsed.command === 'doctor' && parsed.dryRun) {
    throw new InstallerError('doctor 不需要 --dry-run', 'INVALID_ARGUMENT');
  }
  return parsed;
}

export function helpText() {
  return `requirements-refiner [install|update|doctor|uninstall] [options]\n\n` +
    `默认命令：install\n\n` +
    `选项：\n` +
    `  -y, --yes              跳过修改前确认\n` +
    `      --dry-run          只检查并展示操作\n` +
    `      --json             输出 JSON\n` +
    `      --codex-home PATH  指定 Codex Home\n` +
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
        `移除插件 ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
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
      `写入独立 Marketplace ${paths.marketplaceFile}`,
      `固定 npm 包 ${PACKAGE_NAME}@${version}`,
      `安装插件 ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
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

function humanResult(result) {
  if (result.command === 'doctor') {
    return [
      result.ok ? '环境检查通过。' : '环境检查发现问题。',
      ...result.checks.map((item) => `- ${item.ok ? '通过' : '失败'} ${item.name}：${item.detail}`),
      `- 提示：${result.note}`,
    ].join('\n');
  }
  if (result.alreadyInstalled) return `requirements-refiner ${result.version} 已安装，无需重复操作。`;
  if (result.alreadyRemoved) return 'requirements-refiner 已卸载。';
  if (result.command === 'uninstall') return '卸载完成。项目需求文档与 UI 缓存未被修改。';
  return `安装完成：requirements-refiner ${result.version}。请新建 Codex 任务后使用 $requirements-refiner。`;
}

export async function runCli(argv, overrides = {}) {
  const parsed = parseArguments(argv);
  const deps = dependencies(overrides);
  const version = deps.packageVersion ?? await packageVersion();
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
  const paths = resolveInstallerPaths({ codexHome: parsed.codexHome, env: deps.env, home: deps.home });

  if (parsed.command === 'doctor') {
    const result = await doctor(parsed, { ...deps, packageVersion: version });
    stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${humanResult(result)}\n`);
    return { exitCode: result.ok ? 0 : 1, result };
  }

  const runtime = await preflight(deps, { npm: parsed.command !== 'uninstall' });
  const planned = preview(parsed.command, version, paths);
  if (!parsed.json) stderr.write(`${humanPreview(planned)}\n`);
  if (parsed.dryRun) {
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
    ? await uninstall(parsed, { ...deps, packageVersion: version, runtime })
    : await installOrUpdate(parsed, { ...deps, packageVersion: version, runtime });
  stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${humanResult(result)}\n`);
  return { exitCode: 0, result };
}
