#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const localWorkspace = path.join(path.parse(root).root, 'Users', 'zhiyi', 'Documents', 'Workflow');

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

const packageJson = await readJson('package.json');
const plugin = await readJson('.codex-plugin/plugin.json');
if (packageJson.name !== 'requirements-refiner') errors.push('npm 包名不正确');
if (packageJson.version !== plugin.version) errors.push('package.json 与 plugin.json 版本不一致');
if (plugin.name !== 'requirements-refiner') errors.push('插件名称不正确');
if (plugin.skills !== './skills/') errors.push('插件 skills 入口必须是 ./skills/');
if ('mcpServers' in plugin) errors.push('plugin.json 不得绑定 MCP 服务器');
if ('apps' in plugin || 'hooks' in plugin) errors.push('plugin.json 包含未实现的组件声明');
if (packageJson.scripts?.postinstall) errors.push('不得使用 postinstall');
if (packageJson.engines?.node !== '>=20') errors.push('Node 版本要求必须为 >=20');
if (packageJson.publishConfig?.access !== 'public') errors.push('npm 包必须配置公开发布');
if (!packageJson.files?.includes('skills/')) errors.push('npm files 白名单缺少 skills/');
for (const forbidden of ['docs/', 'test/', '_sources/']) {
  if (packageJson.files?.includes(forbidden)) errors.push(`npm files 不得包含 ${forbidden}`);
}

const required = [
  'skills/requirements-refiner/SKILL.md',
  'skills/requirements-refiner/agents/openai.yaml',
  'skills/requirements-refiner/scripts/build-requirement-index.mjs',
  'skills/requirements-refiner/scripts/resolve-mcp-tools.mjs',
  'skills/requirements-refiner/scripts/ui-context-cache.mjs',
];
const files = await listFiles(root);
for (const target of required) if (!files.includes(target)) errors.push(`缺少文件：${target}`);
if (files.some((file) => file.endsWith('/.mcp.json') || file === '.mcp.json')) errors.push('包内不得包含 .mcp.json');

for (const file of files.filter((name) => /\.(?:md|mjs|json|yaml)$/u.test(name))) {
  const content = await readFile(path.join(root, file), 'utf8');
  if (content.includes(localWorkspace)) errors.push(`${file} 包含本机绝对工作区路径`);
  if (/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/u.test(content)) errors.push(`${file} 疑似包含私钥`);
}

const result = { valid: errors.length === 0, files: files.length, errors };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
