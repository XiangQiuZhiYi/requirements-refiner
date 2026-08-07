#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMcpTools } from '../skills/requirements-refiner/scripts/resolve-mcp-tools.mjs';
import {
  finalizeUiCache,
  initializeUiCache,
  mapUiFragment,
  markUiCacheMissing,
  putUiSection,
  validateUiCaches,
} from '../skills/requirements-refiner/scripts/ui-context-cache.mjs';
import { extractUiContext } from '../skills/requirements-refiner/scripts/extract-ui-context.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptDir = path.resolve(testDir, '..', 'skills', 'requirements-refiner', 'scripts');
const extractScript = path.join(scriptDir, 'extract-ui-context.mjs');

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
  await putUiSection(root, { sourceId: 'UI-01', sectionIndex: 0, content: JSON.stringify({ name: '教师端', nodes: [{ id: '2:4' }] }) });
  await putUiSection(root, { sourceId: 'UI-01', sectionIndex: 1, content: JSON.stringify({ name: '家长端', nodes: [{ id: '2:5' }] }) });
  await mapUiFragment(root, { sourceId: 'UI-01', fragmentId: 'UI-01-S001', sections: [1], nodes: ['2:5'] });
  const finalized = await finalizeUiCache(root, 'UI-01');
  assert.equal(finalized.manifest.status, 'complete');
  assert.equal(finalized.manifest.fetchedSections, 2);
  assert.equal((await validateUiCaches(root)).errors.length, 0);

  const extracted = await extractUiContext(root, { sourceId: 'UI-01', fragments: ['UI-01-S001'] });
  assert.equal(extracted.sections.length, 1);
  assert.equal(extracted.sections[0].content.name, '家长端');
  const cliExtracted = JSON.parse(execFileSync(process.execPath, [extractScript, root, '--source', 'UI-01', '--sections', '0-1'], { encoding: 'utf8' }));
  assert.equal(cliExtracted.sections.length, 2);

  await markUiCacheMissing(root, {
    sourceId: 'UI-02',
    sourceUrl: 'https://mastergo.example/file/2',
    expectedSections: 8,
    reason: '历史抓取未保存完整返回值',
  });
  const report = await validateUiCaches(root);
  assert.equal(report.errors.length, 0);
  assert.match(report.warnings.join('\n'), /UI-02 完整 UI 原始缓存缺失/u);
  assert.equal(JSON.parse(await readFile(path.join(root, '_sources', 'raw', 'UI-01', 'manifest.json'), 'utf8')).status, 'complete');

  process.stdout.write('requirements-refiner UI context tools: all tests passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
