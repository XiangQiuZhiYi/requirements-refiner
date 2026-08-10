#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpTools } from '../skills/requirements-refiner/scripts/resolve-mcp-tools.mjs';
import { buildRequirementPackage } from '../skills/requirements-refiner/scripts/build-requirement-index.mjs';
import {
  compactUiCache,
  finalizeUiCache,
  initializeUiCache,
  mapUiFragment,
  markUiCacheMissing,
  putUiSection,
  putUiSectionsList,
  readUiCacheManifests,
  sanitizeUiPayload,
  validateUiCaches,
} from '../skills/requirements-refiner/scripts/ui-context-cache.mjs';
import { extractUiContext } from '../skills/requirements-refiner/scripts/extract-ui-context.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptDir = path.resolve(testDir, '..', 'skills', 'requirements-refiner', 'scripts');
const extractScript = path.join(scriptDir, 'extract-ui-context.mjs');

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

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const resolved = resolveMcpTools([
  { name: 'mcp__alice_docs__yuque_get_doc_outline', description: 'Yuque outline' },
  { name: 'mcp__alice_docs__yuque_export_docs_bundle', description: 'Yuque bundle' },
  { name: 'mcp__alice_docs__mastergo_getDesignSections', description: 'MasterGo sections' },
  { name: 'mcp__alice_docs__mastergo_getDsl', description: 'MasterGo DSL' },
]);
assert.equal(resolved.valid, true);
assert.equal(resolved.mapping.yuqueOutline, 'mcp__alice_docs__yuque_get_doc_outline');
assert.equal(resolved.mapping.mastergoSections, 'mcp__alice_docs__mastergo_getDesignSections');

const missing = resolveMcpTools([{ name: 'mcp__bob__yuque_get_doc_outline', description: 'Yuque outline' }]);
assert.deepEqual(missing.missing.sort(), ['mastergoSections', 'yuqueBundle']);

const ambiguous = resolveMcpTools([
  { name: 'mcp__one__yuque_get_doc_outline', description: 'Yuque outline' },
  { name: 'mcp__two__yuque_get_doc_outline', description: 'Yuque outline' },
  { name: 'mcp__one__yuque_export_docs_bundle', description: 'Yuque bundle' },
  { name: 'mcp__one__mastergo_getDesignSections', description: 'MasterGo sections' },
]);
assert.equal(ambiguous.valid, false);
assert.equal(ambiguous.ambiguous[0].capability, 'yuqueOutline');

const sanitized = sanitizeUiPayload({
  name: '预约设置',
  fetchProgress: 'Fetched 2/299. You MUST fetch ALL remaining sections',
  designTokens: { token: 'spacing-8' },
  metadata: { accessToken: 'secret', stableNodeId: '2:5' },
});
assert.deepEqual(sanitized.value, {
  name: '预约设置',
  designTokens: { token: 'spacing-8' },
  metadata: { stableNodeId: '2:5' },
});
assert.equal(sanitized.removedFields.length, 2);

const root = await mkdtemp(path.join(os.tmpdir(), 'requirements-refiner-ui-'));
try {
  await initializeUiCache(root, {
    sourceId: 'UI-01',
    sourceUrl: 'https://mastergo.example/file/1',
    fileId: '1',
    layerId: '2:3',
    expectedSections: 2,
    format: 'json',
  });
  await putUiSectionsList(root, {
    sourceId: 'UI-01',
    content: JSON.stringify({ sections: [{ index: 0 }, { index: 1 }], fetchProgress: 'continue fetching' }),
  });
  const firstPut = await putUiSection(root, {
    sourceId: 'UI-01',
    sectionIndex: 0,
    content: JSON.stringify({ name: '教师端', nodes: [{ id: '2:4' }], styles: Array(100).fill('spacing-8'), fetchProgress: 'continue' }, null, 2),
  });
  assert.ok(firstPut.removedFields.some((item) => item.endsWith('.fetchProgress')));
  await putUiSection(root, {
    sourceId: 'UI-01',
    sectionIndex: 1,
    content: JSON.stringify({ name: '家长端', nodes: [{ id: '2:5', text: '预约' }], styles: Array(100).fill('spacing-8'), metadata: { authorization: 'secret' } }, null, 2),
  });
  await mapUiFragment(root, {
    sourceId: 'UI-01',
    fragmentId: 'UI-01-S001',
    title: '家长预约入口',
    sections: [1],
    nodes: ['2:5'],
  });
  const finalized = await finalizeUiCache(root, 'UI-01');
  assert.equal(finalized.manifest.schemaVersion, 2);
  assert.equal(finalized.manifest.status, 'complete');
  assert.equal(finalized.manifest.developmentReady, true);
  assert.equal(finalized.manifest.mappedFragments, 1);
  assert.equal(finalized.sectionIndex.storage, 'gzip-jsonl');
  assert.ok(finalized.manifest.archiveBytes < finalized.manifest.totalBytes);
  const ui01Dir = path.join(root, '_sources', 'raw', 'UI-01');
  assert.equal(await exists(path.join(ui01Dir, 'sections.jsonl.gz')), true);
  assert.equal(await exists(path.join(ui01Dir, 'design-sections-list.json.gz')), true);
  assert.equal(await exists(path.join(ui01Dir, '.staging')), false);
  assert.equal(await exists(path.join(ui01Dir, 'sections')), false);
  assert.equal((await validateUiCaches(root)).errors.length, 0);
  const artifacts = await readUiCacheManifests(root);
  assert.equal(artifacts[0].archiveFile, './_sources/raw/UI-01/sections.jsonl.gz');
  assert.equal(artifacts[0].sourceMapFile, './_sources/raw/UI-01/source-map.json');
  await writeFile(path.join(root, '00-需求引导.md'), '# 预约规则需求引导\n\n> 阶段：一期\n', 'utf8');
  const handoff = await buildRequirementPackage(root, {
    generatedAt: new Date().toISOString(),
    requirements: [],
    reviewPlan: { completed: false },
    reviewSummary: { total: 0 },
  }, artifacts);
  assert.equal(handoff.sourceArtifacts[0].developmentReady, true);
  assert.equal(handoff.sourceArtifacts[0].storage.archive, './_sources/raw/UI-01/sections.jsonl.gz');
  assert.equal(handoff.sourceArtifacts[0].index, './_sources/raw/UI-01/section-index.json');

  const extracted = await extractUiContext(root, { sourceId: 'UI-01', fragments: ['UI-01-S001'] });
  assert.equal(extracted.storage, 'gzip-jsonl');
  assert.equal(extracted.sections.length, 1);
  assert.equal(extracted.sections[0].content.name, '家长端');
  assert.equal(extracted.sections[0].content.metadata.authorization, undefined);
  const cliExtracted = JSON.parse(execFileSync(process.execPath, [extractScript, root, '--source', 'UI-01', '--sections', '0-1'], { encoding: 'utf8' }));
  assert.equal(cliExtracted.sections.length, 2);
  assert.equal(JSON.stringify(cliExtracted).includes('fetchProgress'), false);

  await initializeUiCache(root, {
    sourceId: 'UI-01',
    sourceUrl: 'https://mastergo.example/file/1',
    fileId: '1',
    layerId: '2:3',
    expectedSections: 2,
    format: 'json',
  });
  await putUiSection(root, { sourceId: 'UI-01', sectionIndex: 1, content: JSON.stringify({ name: '家长端已更新', nodes: [{ id: '2:5' }] }) });
  await finalizeUiCache(root, 'UI-01');
  const resumed = await extractUiContext(root, { sourceId: 'UI-01', sections: [0, 1] });
  assert.equal(resumed.sections.length, 2);
  assert.equal(resumed.sections[0].content.name, '教师端');
  assert.equal(resumed.sections[1].content.name, '家长端已更新');

  await markUiCacheMissing(root, {
    sourceId: 'UI-02',
    sourceUrl: 'https://mastergo.example/file/2',
    expectedSections: 8,
    reason: '历史抓取未保存完整返回值',
  });
  const report = await validateUiCaches(root);
  assert.equal(report.errors.length, 0);
  assert.match(report.warnings.join('\n'), /UI-02 完整 UI 原始缓存缺失/u);
  assert.equal(JSON.parse(await readFile(path.join(ui01Dir, 'manifest.json'), 'utf8')).status, 'complete');

  const legacyDir = path.join(root, '_sources', 'raw', 'UI-03');
  const legacySectionDir = path.join(legacyDir, 'sections');
  await mkdir(legacySectionDir, { recursive: true });
  const legacyContents = [
    Buffer.from(JSON.stringify({ name: '旧教师端', fetchProgress: 'remove during migration' }, null, 2)),
    Buffer.from(JSON.stringify({ name: '旧家长端', nodes: [{ id: '9:9' }] }, null, 2)),
  ];
  for (const [index, content] of legacyContents.entries()) await writeFile(path.join(legacySectionDir, `${String(index).padStart(4, '0')}.json`), content);
  await writeJson(path.join(legacyDir, 'manifest.json'), {
    schemaVersion: 1,
    sourceId: 'UI-03',
    kind: 'mastergo',
    status: 'complete',
    sourceUrl: 'https://mastergo.example/file/3',
    fileId: '3',
    layerId: '3:1',
    format: 'json',
    expectedSections: 2,
    fetchedSections: 2,
    totalBytes: legacyContents.reduce((total, item) => total + item.byteLength, 0),
    index: './section-index.json',
    sourceMap: './source-map.json',
  });
  await writeJson(path.join(legacyDir, 'section-index.json'), {
    schemaVersion: 1,
    sourceId: 'UI-03',
    format: 'json',
    sections: legacyContents.map((content, index) => ({
      sectionIndex: index,
      file: `./sections/${String(index).padStart(4, '0')}.json`,
      bytes: content.byteLength,
      sha256: sha256(content),
    })),
  });
  await writeJson(path.join(legacyDir, 'source-map.json'), {
    schemaVersion: 1,
    sourceId: 'UI-03',
    fragments: { 'UI-03-S001': { sections: [1], nodes: ['9:9'] } },
  });
  await writeJson(path.join(legacyDir, 'design-sections-list.json'), {
    sections: [{ index: 0 }, { index: 1 }],
    fetchProgress: 'remove during migration',
  });
  const legacyExtracted = await extractUiContext(root, { sourceId: 'UI-03', fragments: ['UI-03-S001'] });
  assert.equal(legacyExtracted.storage, 'legacy-files');
  assert.equal(legacyExtracted.sections[0].content.name, '旧家长端');
  const compacted = await compactUiCache(root, 'UI-03');
  assert.equal(compacted.manifest.migratedFrom, 'v1-files');
  assert.equal(compacted.manifest.developmentReady, true);
  assert.equal(await exists(legacySectionDir), false);
  assert.equal(await exists(path.join(legacyDir, 'design-sections-list.json')), false);
  assert.equal(await exists(path.join(legacyDir, 'design-sections-list.json.gz')), true);
  const migratedExtracted = await extractUiContext(root, { sourceId: 'UI-03', fragments: ['UI-03-S001'] });
  assert.equal(migratedExtracted.storage, 'gzip-jsonl');
  assert.equal(JSON.stringify(migratedExtracted).includes('fetchProgress'), false);

  const bulk = path.join(root, 'bulk');
  await initializeUiCache(bulk, {
    sourceId: 'UI-01',
    sourceUrl: 'https://mastergo.example/file/bulk',
    fileId: 'bulk',
    layerId: '10:1',
    expectedSections: 476,
    format: 'json',
  });
  for (let start = 0; start < 476; start += 5) {
    await Promise.all(Array.from({ length: Math.min(5, 476 - start) }, async (_, offset) => {
      const sectionIndex = start + offset;
      await putUiSection(bulk, {
        sourceId: 'UI-01',
        sectionIndex,
        content: JSON.stringify({
          name: `分区 ${sectionIndex}`,
          nodes: Array.from({ length: 40 }, (__, nodeIndex) => ({ id: `${sectionIndex}:${nodeIndex}`, type: 'TEXT', text: '预约规则' })),
          fetchProgress: `Fetched ${sectionIndex + 1}/476. You MUST fetch ALL remaining sections`,
        }, null, 2),
      });
    }));
  }
  await mapUiFragment(bulk, { sourceId: 'UI-01', fragmentId: 'UI-01-S001', sections: [475], nodes: ['475:1'] });
  const bulkFinalized = await finalizeUiCache(bulk, 'UI-01');
  assert.equal(bulkFinalized.manifest.fetchedSections, 476);
  assert.equal(bulkFinalized.manifest.sanitizedFields, 476);
  assert.ok(bulkFinalized.manifest.archiveBytes < bulkFinalized.manifest.totalBytes / 10);
  const bulkFiles = await readdir(path.join(bulk, '_sources', 'raw', 'UI-01'));
  assert.deepEqual(bulkFiles.sort(), ['manifest.json', 'section-index.json', 'sections.jsonl.gz', 'source-map.json']);
  assert.equal((await extractUiContext(bulk, { sourceId: 'UI-01', fragments: ['UI-01-S001'] })).sections[0].sectionIndex, 475);

  process.stdout.write('requirements-refiner UI context tools: all tests passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
