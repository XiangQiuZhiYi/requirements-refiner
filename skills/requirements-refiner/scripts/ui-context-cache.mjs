#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_PATTERN = /^UI-\d{2}$/u;
const FRAGMENT_PATTERN = /^UI-\d{2}-S\d{3}$/u;
const FORMATS = new Set(['json', 'yaml', 'tree']);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function integerOption(args, name, fallback = 0) {
  const value = option(args, name, '');
  if (value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} 必须是非负整数`);
  return number;
}

function assertSourceId(sourceId) {
  if (!SOURCE_PATTERN.test(sourceId)) throw new Error(`来源编号无效：${sourceId}`);
}

function cachePaths(rootInput, sourceId) {
  const rootDir = path.resolve(rootInput);
  const cacheDir = path.join(rootDir, '_sources', 'raw', sourceId);
  return {
    rootDir,
    cacheDir,
    sectionsDir: path.join(cacheDir, 'sections'),
    manifestPath: path.join(cacheDir, 'manifest.json'),
    indexPath: path.join(cacheDir, 'section-index.json'),
    sourceMapPath: path.join(cacheDir, 'source-map.json'),
  };
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function initializeUiCache(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const format = options.format ?? 'json';
  if (!FORMATS.has(format)) throw new Error(`缓存格式无效：${format}`);
  await mkdir(paths.sectionsDir, { recursive: true });
  const previous = await readJson(paths.manifestPath, {});
  const manifest = {
    schemaVersion: 1,
    sourceId,
    kind: 'mastergo',
    status: 'partial',
    sourceUrl: options.sourceUrl ?? previous.sourceUrl ?? '',
    fileId: options.fileId ?? previous.fileId ?? '',
    layerId: options.layerId ?? previous.layerId ?? '',
    sourceLayerId: options.sourceLayerId ?? previous.sourceLayerId ?? '',
    format,
    expectedSections: options.expectedSections ?? previous.expectedSections ?? 0,
    fetchedSections: previous.fetchedSections ?? 0,
    totalBytes: previous.totalBytes ?? 0,
    capturedAt: previous.capturedAt ?? new Date().toISOString(),
    finalizedAt: null,
    index: './section-index.json',
    sourceMap: './source-map.json',
  };
  await writeJson(paths.manifestPath, manifest);
  if (!(await exists(paths.sourceMapPath))) {
    await writeJson(paths.sourceMapPath, { schemaVersion: 1, sourceId, fragments: {} });
  }
  return { paths, manifest };
}

export async function putUiSection(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = await readJson(paths.manifestPath);
  if (!manifest) throw new Error(`${sourceId} 尚未初始化缓存`);
  const sectionIndex = Number(options.sectionIndex);
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) throw new Error('sectionIndex 必须是非负整数');
  const format = options.format ?? manifest.format ?? 'json';
  if (!FORMATS.has(format)) throw new Error(`缓存格式无效：${format}`);
  const content = Buffer.isBuffer(options.content) ? options.content : Buffer.from(String(options.content), 'utf8');
  if (format === 'json') JSON.parse(content.toString('utf8'));
  await mkdir(paths.sectionsDir, { recursive: true });
  const filename = `${String(sectionIndex).padStart(4, '0')}.${format}`;
  const target = path.join(paths.sectionsDir, filename);
  await writeFile(target, content);
  return { sectionIndex, file: `./sections/${filename}`, bytes: content.byteLength, sha256: sha256(content) };
}

export async function mapUiFragment(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  if (!FRAGMENT_PATTERN.test(options.fragmentId) || !options.fragmentId.startsWith(`${sourceId}-`)) {
    throw new Error(`来源片段编号无效：${options.fragmentId}`);
  }
  const paths = cachePaths(rootInput, sourceId);
  const sourceMap = await readJson(paths.sourceMapPath, { schemaVersion: 1, sourceId, fragments: {} });
  sourceMap.fragments[options.fragmentId] = {
    sections: [...new Set(options.sections ?? [])].sort((a, b) => a - b),
    nodes: [...new Set(options.nodes ?? [])],
  };
  await writeJson(paths.sourceMapPath, sourceMap);
  return sourceMap.fragments[options.fragmentId];
}

export async function finalizeUiCache(rootInput, sourceId) {
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = await readJson(paths.manifestPath);
  if (!manifest) throw new Error(`${sourceId} 尚未初始化缓存`);
  const entries = (await readdir(paths.sectionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}\.(?:json|yaml|tree)$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sections = [];
  for (const entry of entries) {
    const content = await readFile(path.join(paths.sectionsDir, entry.name));
    sections.push({
      sectionIndex: Number(entry.name.slice(0, 4)),
      file: `./sections/${entry.name}`,
      bytes: content.byteLength,
      sha256: sha256(content),
    });
  }
  const expected = Number(manifest.expectedSections ?? 0);
  const complete = expected > 0
    && sections.length === expected
    && sections.every((item, index) => item.sectionIndex === index);
  const sectionIndex = {
    schemaVersion: 1,
    sourceId,
    format: manifest.format,
    sections,
  };
  await writeJson(paths.indexPath, sectionIndex);
  const nextManifest = {
    ...manifest,
    status: complete ? 'complete' : 'partial',
    fetchedSections: sections.length,
    totalBytes: sections.reduce((total, item) => total + item.bytes, 0),
    finalizedAt: new Date().toISOString(),
  };
  delete nextManifest.reason;
  await writeJson(paths.manifestPath, nextManifest);
  return { paths, manifest: nextManifest, sectionIndex };
}

export async function markUiCacheMissing(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = {
    schemaVersion: 1,
    sourceId,
    kind: 'mastergo',
    status: 'missing',
    sourceUrl: options.sourceUrl ?? '',
    fileId: options.fileId ?? '',
    layerId: options.layerId ?? '',
    sourceLayerId: options.sourceLayerId ?? '',
    format: options.format ?? 'json',
    expectedSections: options.expectedSections ?? 0,
    fetchedSections: 0,
    totalBytes: 0,
    capturedAt: null,
    finalizedAt: new Date().toISOString(),
    index: './section-index.json',
    sourceMap: './source-map.json',
    reason: options.reason || '完整 UI 原始数据未落盘',
  };
  await writeJson(paths.manifestPath, manifest);
  await writeJson(paths.indexPath, { schemaVersion: 1, sourceId, format: manifest.format, sections: [] });
  await writeJson(paths.sourceMapPath, { schemaVersion: 1, sourceId, fragments: {} });
  return { paths, manifest };
}

export async function readUiCacheManifests(rootInput) {
  const rawRoot = path.join(path.resolve(rootInput), '_sources', 'raw');
  let entries;
  try {
    entries = await readdir(rawRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SOURCE_PATTERN.test(entry.name)) continue;
    const manifestPath = path.join(rawRoot, entry.name, 'manifest.json');
    const manifest = await readJson(manifestPath);
    if (manifest) manifests.push({
      ...manifest,
      manifest: path.relative(path.resolve(rootInput), manifestPath).split(path.sep).join('/'),
    });
  }
  return manifests.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export async function validateUiCaches(rootInput) {
  const rootDir = path.resolve(rootInput);
  const errors = [];
  const warnings = [];
  const sourceMaps = {};
  const manifests = await readUiCacheManifests(rootDir);
  for (const manifest of manifests) {
    if (manifest.schemaVersion !== 1) errors.push(`${manifest.sourceId} UI 缓存 schemaVersion 无效`);
    if (!['complete', 'partial', 'missing'].includes(manifest.status)) errors.push(`${manifest.sourceId} UI 缓存状态无效：${manifest.status}`);
    if (manifest.status === 'missing') {
      sourceMaps[manifest.sourceId] = [];
      warnings.push(`${manifest.sourceId} 完整 UI 原始缓存缺失：${manifest.reason || '未说明原因'}`);
      continue;
    }
    const paths = cachePaths(rootDir, manifest.sourceId);
    const sourceMap = await readJson(paths.sourceMapPath);
    if (!sourceMap) errors.push(`${manifest.sourceId} 缺少 source-map.json`);
    const mappedFragments = Object.keys(sourceMap?.fragments ?? {});
    sourceMaps[manifest.sourceId] = mappedFragments;
    if (manifest.status === 'complete' && mappedFragments.length === 0) warnings.push(`${manifest.sourceId} 已缓存完整 UI，但尚未建立来源片段映射`);
    const index = await readJson(paths.indexPath);
    if (!index) {
      errors.push(`${manifest.sourceId} 缺少 section-index.json`);
      continue;
    }
    if ((index.sections ?? []).length !== manifest.fetchedSections) errors.push(`${manifest.sourceId} 缓存分区数量与 manifest 不一致`);
    for (const item of index.sections ?? []) {
      const target = path.resolve(paths.cacheDir, item.file);
      if (!target.startsWith(`${paths.cacheDir}${path.sep}`) || !(await exists(target))) {
        errors.push(`${manifest.sourceId} 缓存分区文件缺失：${item.file}`);
        continue;
      }
      const content = await readFile(target);
      if (content.byteLength !== item.bytes || sha256(content) !== item.sha256) errors.push(`${manifest.sourceId} 缓存分区校验失败：${item.file}`);
    }
    if (manifest.status === 'complete' && manifest.expectedSections !== manifest.fetchedSections) {
      errors.push(`${manifest.sourceId} 标记完整但分区数不一致`);
    }
    if (manifest.status === 'partial') warnings.push(`${manifest.sourceId} UI 原始缓存不完整：${manifest.fetchedSections}/${manifest.expectedSections}`);
  }
  return { manifests, sourceMaps, errors, warnings };
}

function parseList(value, numeric = false) {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!numeric) return item;
    const number = Number(item);
    if (!Number.isInteger(number) || number < 0) throw new Error(`分区编号无效：${item}`);
    return number;
  });
}

async function main() {
  const [command, rootDir, ...args] = process.argv.slice(2);
  const sourceId = option(args, '--source');
  if (!command || !rootDir || !sourceId) {
    process.stderr.write('用法: node ui-context-cache.mjs <init|put|map|finalize|mark-missing|status> <需求包目录> --source UI-01 [选项]\n');
    process.exitCode = 2;
    return;
  }
  try {
    let result;
    if (command === 'init') {
      result = await initializeUiCache(rootDir, {
        sourceId,
        sourceUrl: option(args, '--source-url'),
        fileId: option(args, '--file-id'),
        layerId: option(args, '--layer-id'),
        sourceLayerId: option(args, '--source-layer-id'),
        expectedSections: integerOption(args, '--expected-sections'),
        format: option(args, '--format', 'json'),
      });
    } else if (command === 'put') {
      const input = option(args, '--input');
      if (!input) throw new Error('put 需要 --input <文件>');
      result = await putUiSection(rootDir, {
        sourceId,
        sectionIndex: integerOption(args, '--section'),
        format: option(args, '--format', '') || undefined,
        content: await readFile(path.resolve(input)),
      });
    } else if (command === 'map') {
      result = await mapUiFragment(rootDir, {
        sourceId,
        fragmentId: option(args, '--fragment'),
        sections: parseList(option(args, '--sections'), true),
        nodes: parseList(option(args, '--nodes')),
      });
    } else if (command === 'finalize') {
      result = await finalizeUiCache(rootDir, sourceId);
    } else if (command === 'mark-missing') {
      result = await markUiCacheMissing(rootDir, {
        sourceId,
        sourceUrl: option(args, '--source-url'),
        fileId: option(args, '--file-id'),
        layerId: option(args, '--layer-id'),
        sourceLayerId: option(args, '--source-layer-id'),
        expectedSections: integerOption(args, '--expected-sections'),
        format: option(args, '--format', 'json'),
        reason: option(args, '--reason'),
      });
    } else if (command === 'status') {
      result = await validateUiCaches(rootDir);
    } else {
      throw new Error(`未知命令：${command}`);
    }
    const printable = result?.paths ? { ...result, paths: undefined } : result;
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
