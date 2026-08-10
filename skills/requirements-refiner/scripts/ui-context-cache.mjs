#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const SOURCE_PATTERN = /^UI-\d{2}$/u;
const FRAGMENT_PATTERN = /^UI-\d{2}-S\d{3}$/u;
const FORMATS = new Set(['json', 'yaml', 'tree']);
const STRIPPED_METADATA_KEYS = new Set([
  'fetchProgress',
  'mcpInstructions',
  'operationInstructions',
  'remainingSectionsInstruction',
  'codeGenerationPrompt',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
]);

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
    stagingDir: path.join(cacheDir, '.staging'),
    legacySectionsDir: path.join(cacheDir, 'sections'),
    manifestPath: path.join(cacheDir, 'manifest.json'),
    indexPath: path.join(cacheDir, 'section-index.json'),
    sourceMapPath: path.join(cacheDir, 'source-map.json'),
    archivePath: path.join(cacheDir, 'sections.jsonl.gz'),
    sectionListArchivePath: path.join(cacheDir, 'design-sections-list.json.gz'),
    legacySectionListPath: path.join(cacheDir, 'design-sections-list.json'),
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

function relativeFromCache(target, cacheDir) {
  return `./${path.relative(cacheDir, target).split(path.sep).join('/')}`;
}

function resolveCacheFile(cacheDir, relative) {
  const target = path.resolve(cacheDir, relative);
  if (target !== cacheDir && !target.startsWith(`${cacheDir}${path.sep}`)) throw new Error(`缓存路径越界：${relative}`);
  return target;
}

export function sanitizeUiPayload(value) {
  const removedFields = [];
  function visit(current, location) {
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${location}[${index}]`));
    if (!current || typeof current !== 'object') return current;
    const result = {};
    for (const [key, child] of Object.entries(current)) {
      if (STRIPPED_METADATA_KEYS.has(key)) {
        removedFields.push(`${location}.${key}`);
        continue;
      }
      result[key] = visit(child, `${location}.${key}`);
    }
    return result;
  }
  return { value: visit(value, '$'), removedFields };
}

function normalizeSection(rawContent, format) {
  const raw = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8');
  if (format !== 'json') {
    const value = raw.toString('utf8');
    return { value, serialized: JSON.stringify(value), removedFields: [], originalBytes: raw.byteLength };
  }
  const parsed = JSON.parse(raw.toString('utf8'));
  const sanitized = sanitizeUiPayload(parsed);
  return {
    value: sanitized.value,
    serialized: JSON.stringify(sanitized.value),
    removedFields: sanitized.removedFields,
    originalBytes: raw.byteLength,
  };
}

function sectionLabel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['name', 'title', 'sectionName']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

async function listSectionFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d{4}\.(?:json|yaml|tree)$/u.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function upgradeSourceMap(paths, sourceId) {
  const current = await readJson(paths.sourceMapPath, { schemaVersion: 2, sourceId, fragments: {} });
  const sourceMap = { schemaVersion: 2, sourceId, fragments: current.fragments ?? {} };
  await writeJson(paths.sourceMapPath, sourceMap);
  return sourceMap;
}

export async function initializeUiCache(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const format = options.format ?? 'json';
  if (!FORMATS.has(format)) throw new Error(`缓存格式无效：${format}`);
  await mkdir(paths.stagingDir, { recursive: true });
  const previous = await readJson(paths.manifestPath, {});
  const manifest = {
    schemaVersion: 2,
    sourceId,
    kind: 'mastergo',
    status: 'partial',
    sourceUrl: options.sourceUrl ?? previous.sourceUrl ?? '',
    fileId: options.fileId ?? previous.fileId ?? '',
    layerId: options.layerId ?? previous.layerId ?? '',
    sourceLayerId: options.sourceLayerId ?? previous.sourceLayerId ?? '',
    format,
    expectedSections: options.expectedSections ?? previous.expectedSections ?? 0,
    fetchedSections: 0,
    totalBytes: 0,
    archiveBytes: previous.archiveBytes ?? 0,
    capturedAt: previous.capturedAt ?? new Date().toISOString(),
    finalizedAt: null,
    storage: {
      type: 'gzip-jsonl',
      archive: './sections.jsonl.gz',
      compression: 'gzip',
    },
    index: './section-index.json',
    sourceMap: './source-map.json',
    ...(previous.sectionList ? { sectionList: previous.sectionList } : {}),
  };
  await writeJson(paths.manifestPath, manifest);
  await upgradeSourceMap(paths, sourceId);
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
  const normalized = normalizeSection(options.content, format);
  await mkdir(paths.stagingDir, { recursive: true });
  const filename = `${String(sectionIndex).padStart(4, '0')}.json`;
  const target = path.join(paths.stagingDir, filename);
  const stagingContent = JSON.stringify({
    cacheSchemaVersion: 2,
    format,
    content: normalized.value,
    originalBytes: normalized.originalBytes,
    removedFields: normalized.removedFields,
  });
  await writeFile(target, stagingContent, 'utf8');
  return {
    sectionIndex,
    stagingFile: relativeFromCache(target, paths.cacheDir),
    originalBytes: normalized.originalBytes,
    bytes: Buffer.byteLength(normalized.serialized),
    sha256: sha256(normalized.serialized),
    removedFields: normalized.removedFields,
  };
}

export async function putUiSectionsList(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = await readJson(paths.manifestPath);
  if (!manifest) throw new Error(`${sourceId} 尚未初始化缓存`);
  const normalized = normalizeSection(options.content, 'json');
  const compressed = gzipSync(Buffer.from(normalized.serialized), { level: 9 });
  await writeFile(paths.sectionListArchivePath, compressed);
  manifest.sectionList = {
    archive: './design-sections-list.json.gz',
    bytes: Buffer.byteLength(normalized.serialized),
    archiveBytes: compressed.byteLength,
    sha256: sha256(compressed),
    removedFields: normalized.removedFields.length,
  };
  await writeJson(paths.manifestPath, manifest);
  return manifest.sectionList;
}

export async function mapUiFragment(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  if (!FRAGMENT_PATTERN.test(options.fragmentId) || !options.fragmentId.startsWith(`${sourceId}-`)) {
    throw new Error(`来源片段编号无效：${options.fragmentId}`);
  }
  const sections = [...new Set(options.sections ?? [])].sort((a, b) => a - b);
  if (sections.some((item) => !Number.isInteger(item) || item < 0)) throw new Error('映射分区必须是非负整数');
  const paths = cachePaths(rootInput, sourceId);
  const sourceMap = await upgradeSourceMap(paths, sourceId);
  sourceMap.fragments[options.fragmentId] = {
    sections,
    nodes: [...new Set(options.nodes ?? [])],
    ...(options.title ? { title: options.title } : {}),
  };
  await writeJson(paths.sourceMapPath, sourceMap);
  return sourceMap.fragments[options.fragmentId];
}

async function readArchivedSections(paths, format) {
  if (!(await exists(paths.archivePath))) return [];
  const lines = gunzipSync(await readFile(paths.archivePath)).toString('utf8').split('\n').filter(Boolean);
  return lines.map((line) => {
    const envelope = JSON.parse(line);
    const normalized = normalizeSection(format === 'json' ? JSON.stringify(envelope.content) : String(envelope.content), format);
    return {
      sectionIndex: envelope.sectionIndex,
      value: normalized.value,
      serialized: normalized.serialized,
      label: sectionLabel(normalized.value),
      removedFields: normalized.removedFields.length,
      originalBytes: normalized.originalBytes,
      origin: 'archive',
    };
  });
}

async function readSectionDirectory(directory, format, origin) {
  const entries = await listSectionFiles(directory);
  const result = [];
  for (const entry of entries) {
    const content = await readFile(path.join(directory, entry.name));
    if (origin === 'staging') {
      const envelope = JSON.parse(content.toString('utf8'));
      if (envelope.cacheSchemaVersion !== 2 || envelope.format !== format) throw new Error(`UI 暂存分区格式无效：${entry.name}`);
      const serialized = JSON.stringify(envelope.content);
      result.push({
        sectionIndex: Number(entry.name.slice(0, 4)),
        value: envelope.content,
        serialized,
        label: sectionLabel(envelope.content),
        removedFields: Array.isArray(envelope.removedFields) ? envelope.removedFields.length : 0,
        originalBytes: Number(envelope.originalBytes ?? Buffer.byteLength(serialized)),
        origin,
      });
      continue;
    }
    const normalized = normalizeSection(content, format);
    result.push({
      sectionIndex: Number(entry.name.slice(0, 4)),
      value: normalized.value,
      serialized: normalized.serialized,
      label: sectionLabel(normalized.value),
      removedFields: normalized.removedFields.length,
      originalBytes: normalized.originalBytes,
      origin,
    });
  }
  return result;
}

async function readInputSections(paths, format) {
  const archived = await readArchivedSections(paths, format);
  const legacy = await readSectionDirectory(paths.legacySectionsDir, format, 'legacy');
  const staging = await readSectionDirectory(paths.stagingDir, format, 'staging');
  const bySection = new Map();
  for (const item of [...archived, ...legacy, ...staging]) bySection.set(item.sectionIndex, item);
  const sections = [...bySection.values()].sort((left, right) => left.sectionIndex - right.sectionIndex);
  if (sections.length === 0) throw new Error('没有可归档的 UI 分区，请先执行 put 或确认旧缓存目录存在');
  let removedFields = 0;
  let originalBytes = 0;
  for (const item of sections) {
    removedFields += item.removedFields;
    originalBytes += item.originalBytes;
  }
  return { sections, migratedFrom: legacy.length > 0 ? 'v1-files' : null, removedFields, originalBytes };
}

async function migrateLegacySectionList(paths, current) {
  if (current?.archive && await exists(resolveCacheFile(paths.cacheDir, current.archive))) return current;
  if (!(await exists(paths.legacySectionListPath))) return current;
  const normalized = normalizeSection(await readFile(paths.legacySectionListPath), 'json');
  const compressed = gzipSync(Buffer.from(normalized.serialized), { level: 9 });
  await writeFile(paths.sectionListArchivePath, compressed);
  return {
    archive: './design-sections-list.json.gz',
    bytes: Buffer.byteLength(normalized.serialized),
    archiveBytes: compressed.byteLength,
    sha256: sha256(compressed),
    removedFields: normalized.removedFields.length,
  };
}

export async function finalizeUiCache(rootInput, sourceId) {
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = await readJson(paths.manifestPath);
  if (!manifest) throw new Error(`${sourceId} 尚未初始化缓存`);
  const format = manifest.format ?? 'json';
  const input = await readInputSections(paths, format);
  const lines = [];
  const sections = [];
  for (const [lineIndex, item] of input.sections.entries()) {
    const envelope = JSON.stringify({ sectionIndex: item.sectionIndex, content: item.value });
    lines.push(`${envelope}\n`);
    sections.push({
      sectionIndex: item.sectionIndex,
      line: lineIndex + 1,
      bytes: Buffer.byteLength(item.serialized),
      sha256: sha256(item.serialized),
      ...(item.label ? { label: item.label } : {}),
    });
  }
  const archiveContent = Buffer.from(lines.join(''), 'utf8');
  const compressed = gzipSync(archiveContent, { level: 9 });
  await writeFile(paths.archivePath, compressed);
  const verificationLines = gunzipSync(await readFile(paths.archivePath)).toString('utf8').trimEnd().split('\n');
  if (verificationLines.length !== sections.length) throw new Error('UI 压缩归档写入后校验失败');
  const expected = Number(manifest.expectedSections ?? 0);
  const complete = expected > 0
    && sections.length === expected
    && sections.every((item, index) => item.sectionIndex === index);
  const sectionIndex = {
    schemaVersion: 2,
    sourceId,
    format,
    storage: 'gzip-jsonl',
    archive: './sections.jsonl.gz',
    archiveBytes: compressed.byteLength,
    archiveSha256: sha256(compressed),
    sections,
  };
  await writeJson(paths.indexPath, sectionIndex);
  const sourceMap = await upgradeSourceMap(paths, sourceId);
  const mappedFragments = Object.keys(sourceMap.fragments ?? {}).length;
  const totalBytes = sections.reduce((total, item) => total + item.bytes, 0);
  const sectionList = await migrateLegacySectionList(paths, manifest.sectionList);
  const nextManifest = {
    ...manifest,
    schemaVersion: 2,
    status: complete ? 'complete' : 'partial',
    fetchedSections: sections.length,
    totalBytes,
    archiveBytes: compressed.byteLength,
    compressionRatio: totalBytes > 0 ? Number((compressed.byteLength / totalBytes).toFixed(6)) : 0,
    sanitizedFields: input.removedFields,
    finalizedAt: new Date().toISOString(),
    storage: {
      type: 'gzip-jsonl',
      archive: './sections.jsonl.gz',
      compression: 'gzip',
      sha256: sectionIndex.archiveSha256,
    },
    developmentReady: complete && mappedFragments > 0,
    mappedFragments,
    ...(sectionList ? { sectionList } : {}),
    ...(input.migratedFrom ? { migratedFrom: input.migratedFrom } : {}),
  };
  delete nextManifest.reason;
  await writeJson(paths.manifestPath, nextManifest);
  await rm(paths.stagingDir, { recursive: true, force: true });
  await rm(paths.legacySectionsDir, { recursive: true, force: true });
  await rm(paths.legacySectionListPath, { force: true });
  return { paths, manifest: nextManifest, sectionIndex };
}

export async function compactUiCache(rootInput, sourceId) {
  return finalizeUiCache(rootInput, sourceId);
}

export async function markUiCacheMissing(rootInput, options) {
  const sourceId = options.sourceId;
  assertSourceId(sourceId);
  const paths = cachePaths(rootInput, sourceId);
  const manifest = {
    schemaVersion: 2,
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
    archiveBytes: 0,
    capturedAt: null,
    finalizedAt: new Date().toISOString(),
    storage: null,
    index: './section-index.json',
    sourceMap: './source-map.json',
    developmentReady: false,
    mappedFragments: 0,
    reason: options.reason || '完整 UI 原始数据未落盘',
  };
  await writeJson(paths.manifestPath, manifest);
  await writeJson(paths.indexPath, { schemaVersion: 2, sourceId, format: manifest.format, storage: null, sections: [] });
  await writeJson(paths.sourceMapPath, { schemaVersion: 2, sourceId, fragments: {} });
  return { paths, manifest };
}

export async function readUiCacheManifests(rootInput) {
  const rootDir = path.resolve(rootInput);
  const rawRoot = path.join(rootDir, '_sources', 'raw');
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
    if (!manifest) continue;
    const sourceMap = await readJson(path.join(rawRoot, entry.name, 'source-map.json'), { fragments: {} });
    const mappedFragmentIds = Object.keys(sourceMap.fragments ?? {}).sort();
    const relativeManifest = path.relative(rootDir, manifestPath).split(path.sep).join('/');
    const artifactPath = (relative) => relative
      ? `./${path.posix.join(path.posix.dirname(relativeManifest), relative.replace(/^\.\//u, ''))}`
      : null;
    manifests.push({
      ...manifest,
      mappedFragments: mappedFragmentIds.length,
      mappedFragmentIds,
      developmentReady: manifest.status === 'complete' && mappedFragmentIds.length > 0,
      manifest: relativeManifest,
      indexFile: artifactPath(manifest.index),
      sourceMapFile: artifactPath(manifest.sourceMap),
      archiveFile: artifactPath(manifest.storage?.archive),
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
    if (![1, 2].includes(manifest.schemaVersion)) errors.push(`${manifest.sourceId} UI 缓存 schemaVersion 无效`);
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
    if (manifest.status === 'complete' && mappedFragments.length === 0) warnings.push(`${manifest.sourceId} 已缓存完整 UI，但尚未建立来源片段映射，开发只能按分区读取`);
    const index = await readJson(paths.indexPath);
    if (!index) {
      errors.push(`${manifest.sourceId} 缺少 section-index.json`);
      continue;
    }
    if ((index.sections ?? []).length !== manifest.fetchedSections) errors.push(`${manifest.sourceId} 缓存分区数量与 manifest 不一致`);
    const sectionIds = new Set((index.sections ?? []).map((item) => item.sectionIndex));
    if (sectionIds.size !== (index.sections ?? []).length) errors.push(`${manifest.sourceId} section-index.json 包含重复分区`);
    if (manifest.schemaVersion === 2 || manifest.storage?.type === 'gzip-jsonl') {
      const archiveRelative = manifest.storage?.archive ?? index.archive;
      if (!archiveRelative) {
        errors.push(`${manifest.sourceId} 缺少压缩归档路径`);
      } else {
        const archivePath = resolveCacheFile(paths.cacheDir, archiveRelative);
        if (!(await exists(archivePath))) errors.push(`${manifest.sourceId} 缺少压缩归档：${archiveRelative}`);
        else {
          const archive = await readFile(archivePath);
          if (index.archiveBytes !== archive.byteLength || index.archiveSha256 !== sha256(archive)) {
            errors.push(`${manifest.sourceId} 压缩归档校验失败：${archiveRelative}`);
          }
        }
      }
    } else {
      for (const item of index.sections ?? []) {
        const target = resolveCacheFile(paths.cacheDir, item.file);
        if (!(await exists(target))) {
          errors.push(`${manifest.sourceId} 缓存分区文件缺失：${item.file}`);
          continue;
        }
        const content = await readFile(target);
        if (content.byteLength !== item.bytes || sha256(content) !== item.sha256) errors.push(`${manifest.sourceId} 缓存分区校验失败：${item.file}`);
      }
      warnings.push(`${manifest.sourceId} 仍使用逐文件 UI 缓存，可执行 compact 迁移为压缩快照`);
    }
    for (const [fragmentId, mapping] of Object.entries(sourceMap?.fragments ?? {})) {
      for (const sectionIndex of mapping.sections ?? []) {
        if (!sectionIds.has(sectionIndex)) errors.push(`${fragmentId} 映射到不存在的 UI 分区 ${sectionIndex}`);
      }
    }
    if (manifest.sectionList?.archive) {
      const listPath = resolveCacheFile(paths.cacheDir, manifest.sectionList.archive);
      if (!(await exists(listPath))) errors.push(`${manifest.sourceId} 设计分区清单归档不存在`);
      else {
        const content = await readFile(listPath);
        if (content.byteLength !== manifest.sectionList.archiveBytes || sha256(content) !== manifest.sectionList.sha256) {
          errors.push(`${manifest.sourceId} 设计分区清单归档校验失败`);
        }
      }
    }
    if (manifest.status === 'complete' && manifest.expectedSections !== manifest.fetchedSections) errors.push(`${manifest.sourceId} 标记完整但分区数不一致`);
    if (manifest.status === 'partial') warnings.push(`${manifest.sourceId} UI 原始缓存不完整：${manifest.fetchedSections}/${manifest.expectedSections}`);
    if (await exists(paths.stagingDir)) warnings.push(`${manifest.sourceId} 存在尚未 finalize 的 UI 暂存分区`);
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
  if (!command || !rootDir || (!sourceId && command !== 'status')) {
    process.stderr.write('用法: node ui-context-cache.mjs <init|put|put-list|map|finalize|compact|mark-missing|status> <需求包目录> --source UI-01 [选项]\n');
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
    } else if (command === 'put' || command === 'put-list') {
      const input = option(args, '--input');
      if (!input) throw new Error(`${command} 需要 --input <文件>`);
      result = command === 'put'
        ? await putUiSection(rootDir, {
          sourceId,
          sectionIndex: integerOption(args, '--section'),
          format: option(args, '--format', '') || undefined,
          content: await readFile(path.resolve(input)),
        })
        : await putUiSectionsList(rootDir, { sourceId, content: await readFile(path.resolve(input)) });
    } else if (command === 'map') {
      result = await mapUiFragment(rootDir, {
        sourceId,
        fragmentId: option(args, '--fragment'),
        sections: parseList(option(args, '--sections'), true),
        nodes: parseList(option(args, '--nodes')),
        title: option(args, '--title'),
      });
    } else if (command === 'finalize' || command === 'compact') {
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
