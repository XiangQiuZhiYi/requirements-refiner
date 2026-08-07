#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function parseSections(value) {
  const values = new Set();
  for (const part of String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/u);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new Error(`分区范围无效：${part}`);
      for (let index = start; index <= end; index += 1) values.add(index);
      continue;
    }
    if (!/^\d+$/u.test(part)) throw new Error(`分区编号无效：${part}`);
    values.add(Number(part));
  }
  return [...values].sort((left, right) => left - right);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function extractUiContext(rootInput, options) {
  const rootDir = path.resolve(rootInput);
  const cacheDir = path.join(rootDir, '_sources', 'raw', options.sourceId);
  const manifest = await readJson(path.join(cacheDir, 'manifest.json'));
  if (manifest.status === 'missing') throw new Error(`${options.sourceId} 原始缓存缺失：${manifest.reason || '未说明原因'}`);
  const index = await readJson(path.join(cacheDir, 'section-index.json'));
  const sourceMap = await readJson(path.join(cacheDir, 'source-map.json'));
  const selected = new Set(options.sections ?? []);
  for (const fragmentId of options.fragments ?? []) {
    const mapping = sourceMap.fragments?.[fragmentId];
    if (!mapping) throw new Error(`来源片段没有 UI 映射：${fragmentId}`);
    for (const sectionIndex of mapping.sections ?? []) selected.add(sectionIndex);
  }
  if (selected.size === 0) throw new Error('至少提供一个 --sections 或 --fragments');
  const bySection = new Map((index.sections ?? []).map((item) => [item.sectionIndex, item]));
  const sections = [];
  for (const sectionIndex of [...selected].sort((left, right) => left - right)) {
    const item = bySection.get(sectionIndex);
    if (!item) throw new Error(`缓存中不存在分区 ${sectionIndex}`);
    const raw = await readFile(path.resolve(cacheDir, item.file), 'utf8');
    sections.push({
      sectionIndex,
      sourceFile: item.file,
      sha256: item.sha256,
      content: manifest.format === 'json' ? JSON.parse(raw) : raw,
    });
  }
  return {
    schemaVersion: 1,
    sourceId: options.sourceId,
    sourceUrl: manifest.sourceUrl,
    fileId: manifest.fileId,
    layerId: manifest.layerId,
    format: manifest.format,
    sections,
  };
}

async function main() {
  const [rootDir, ...args] = process.argv.slice(2);
  const sourceId = option(args, '--source');
  if (!rootDir || !sourceId) {
    process.stderr.write('用法: node extract-ui-context.mjs <需求包目录> --source UI-01 (--sections 1,2 | --fragments UI-01-S001) [--output 文件]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await extractUiContext(rootDir, {
      sourceId,
      sections: parseSections(option(args, '--sections')),
      fragments: option(args, '--fragments').split(',').map((item) => item.trim()).filter(Boolean),
    });
    const output = `${JSON.stringify(result, null, 2)}\n`;
    const target = option(args, '--output');
    if (target) {
      const absolute = path.resolve(target);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, output, 'utf8');
      process.stdout.write(`${JSON.stringify({ output: absolute, sections: result.sections.length }, null, 2)}\n`);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
