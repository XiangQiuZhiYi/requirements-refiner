#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptDir = path.resolve(testDir, '..', 'skills', 'requirements-refiner', 'scripts');
const buildScript = path.join(scriptDir, 'build-requirement-index.mjs');
const validateScript = path.join(scriptDir, 'validate-requirements.mjs');
const { buildReviewPlan } = await import(pathToFileURL(buildScript));

const batchPlan = buildReviewPlan([{
  id: 'PX-REQ-FR001',
  number: 1,
  title: '创建记录',
  file: '00-需求引导.md',
  line: 10,
  reviewStatus: '未审核',
  syncStatus: 'synced',
}], []);
assert.equal(batchPlan.next.batchConfirmSuggested, true);
assert.equal(batchPlan.next.unreviewedGuidePoints, 1);
assert.deepEqual(batchPlan.next.focusItems, []);

async function write(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function run(script, root, expectSuccess = true, extraArgs = []) {
  try {
    return execFileSync(process.execPath, [script, root, ...extraArgs], { encoding: 'utf8' });
  } catch (error) {
    if (expectSuccess) throw error;
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

function detail(idPrefix = 'PX-REQ') {
  return `# 详细需求\n\n<a id="${idPrefix.toLowerCase()}-fr001"></a>\n### ${idPrefix}-FR001｜创建记录\n\n- 状态：来源已确认\n- 来源：DOC-01「创建」\n\n创建记录。\n\n<a id="${idPrefix.toLowerCase()}-br001"></a>\n### ${idPrefix}-BR001｜唯一性\n\n- 状态：用户已确认\n- 来源：USER-01\n\n名称唯一。\n\n<a id="${idPrefix.toLowerCase()}-ac001"></a>\n### ${idPrefix}-AC001｜创建成功\n\n- 状态：来源已确认\n- 来源：DOC-01「验收」\n\n- Given：输入有效\n- When：提交\n- Then：创建成功\n`;
}

function guide(idPrefix = 'PX-REQ') {
  return `# 审核指南\n\n## 需求背景与目标\n\n帮助管理员创建记录。\n\n## 整体用户流程\n\n1. 填写。\n2. 提交。\n\n## 功能说明\n\n管理员填写必要信息并创建记录，名称必须唯一。\n\n- <!-- req-link:${idPrefix}-FR001 -->\n\n## 来源冲突\n\n如有冲突，同时保留文档和设计原意。\n\n## 必须确认的问题\n\n### ${idPrefix}-Q001｜是否通知用户\n\n- 状态：待确认\n- 关联需求：${idPrefix}-FR001\n- 用户答复：\n- 已同步：否\n\n请确认是否通知。\n`;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'requirements-refiner-test-'));
try {
  const single = path.join(root, 'single');
  await write(path.join(single, '00-需求引导.md'), guide());
  await write(path.join(single, '01-详细需求.md'), detail());
  await write(path.join(single, '_sources', '资料索引.md'), '# 资料索引\n\nDOC-01 已读取。\n');

  const firstBuild = JSON.parse(run(buildScript, single));
  assert.equal(firstBuild.indexed, 3);
  assert.equal(JSON.parse(await readFile(path.join(single, 'requirement-index.json'), 'utf8')).schemaVersion, 2);
  const singlePackage = JSON.parse(await readFile(path.join(single, 'requirement-package.json'), 'utf8'));
  assert.equal(singlePackage.schemaVersion, 1);
  assert.equal(singlePackage.documents.requirementIndex, './requirement-index.json');
  assert.deepEqual(singlePackage.sourceArtifacts, []);
  assert.equal(firstBuild.guideUpdated, true);
  let guideContent = await readFile(path.join(single, '00-需求引导.md'), 'utf8');
  assert.match(guideContent, /本机第 4 行/u);
  assert.match(guideContent, /\.\/01-详细需求\.md#px-req-fr001/u);
  const singleValidation = JSON.parse(run(validateScript, single));
  assert.equal(singleValidation.valid, true);
  assert.equal(singleValidation.unresolvedQuestions, 1);

  await write(path.join(single, '01-详细需求.md'), `# 详细需求\n\n新增说明。\n\n${detail().split('\n').slice(2).join('\n')}`);
  run(buildScript, single);
  guideContent = await readFile(path.join(single, '00-需求引导.md'), 'utf8');
  assert.match(guideContent, /本机第 6 行/u);
  assert.equal(JSON.parse(run(validateScript, single)).valid, true);

  const multi = path.join(root, 'multi');
  await write(path.join(multi, '00-需求引导.md'), guide('P1-UC01'));
  await write(path.join(multi, '01-公共需求.md'), `# 公共需求\n\n<a id="p1-com-br001"></a>\n### P1-COM-BR001｜统一权限\n\n- 状态：来源冲突\n- 来源：DOC-01「权限」；UI-01 节点 3:8\n\nDOC-01 要求仅管理员可用；UI-01 对所有角色展示入口，等待用户确认。\n`);
  await write(path.join(multi, 'UC01-创建记录', '需求引导.md'), `# UC01 创建记录需求引导\n\n## 1. 需求概述\n\n管理员创建记录。\n\n## 2. 使用流程\n\n1. 填写。\n2. 提交。\n\n## 3. 功能点说明\n\n### 功能点 1：创建记录\n\n管理员填写数据后创建记录，并得到成功结果。\n\n- 关键规则：名称唯一。\n- 审核重点：确认是否通知。\n- 参考详细文档：\n  - <!-- req-link:P1-UC01-FR001 -->\n\n## 4. 关键状态、权限与边界\n\n仅管理员。\n\n## 5. 冲突与信息缺失\n\n无。\n\n## 6. 必须确认的问题\n\n### P1-UC01-Q002｜是否二次确认\n\n- 状态：待确认\n- 关联需求：P1-UC01-FR001\n- 用户答复：\n- 已同步：否\n`);
  await write(path.join(multi, 'UC01-创建记录', '详细需求.md'), detail('P1-UC01'));
  await write(path.join(multi, '_sources', '资料索引.md'), '# 资料索引\n\nDOC-01 与 UI-01 已读取。\n\n本次仅基于 MasterGo DSL 分析，未核对原始渲染图。\n');
  run(buildScript, multi);
  const multiValidation = JSON.parse(run(validateScript, multi));
  assert.equal(multiValidation.valid, true);
  assert.equal(multiValidation.requirements, 4);
  assert.equal(multiValidation.unresolvedQuestions, 2);
  const ucGuideContent = await readFile(path.join(multi, 'UC01-创建记录', '需求引导.md'), 'utf8');
  assert.match(ucGuideContent, /\.\/详细需求\.md#p1-uc01-fr001/u);

  await write(path.join(multi, 'UC02-重复编号', '详细需求.md'), detail('P1-UC01'));
  const duplicateReport = run(validateScript, multi, false);
  assert.match(duplicateReport, /需求编号重复/u);
  assert.match(duplicateReport, /UC02-重复编号 缺少需求引导\.md/u);

  const invalid = path.join(root, 'invalid');
  await write(path.join(invalid, '00-需求引导.md'), `# 审核指南\n\n## 需求背景与目标\n\n背景。\n\n## 整体用户流程\n\n1. 操作。\n\n## 功能说明\n\n功能说明。\n\n[坏链接](<./01-详细需求.md#px-req-fr999>)\n\n### PX-REQ-Q001｜未同步回答\n\n- 状态：待确认\n- 关联需求：PX-REQ-FR001\n- 用户答复：采用方案 A\n- 已同步：否\n`);
  await write(path.join(invalid, '01-详细需求.md'), `# 详细需求\n\n### PX-REQ-FR001｜无锚点\n\n- 状态：自动确认\n- 来源：{{来源}}\n\n内容。\n`);
  await write(path.join(invalid, '_sources', '资料索引.md'), '# 资料索引\n\n{{来源}}\n');
  run(buildScript, invalid);
  const invalidReport = run(validateScript, invalid, false);
  assert.match(invalidReport, /缺少锚点/u);
  assert.match(invalidReport, /状态无效/u);
  assert.match(invalidReport, /来源缺失/u);
  assert.match(invalidReport, /锚点不存在/u);
  assert.match(invalidReport, /已填写用户答复/u);
  assert.match(invalidReport, /资料索引\.md 仍包含模板占位符/u);

  const enhanced = path.join(root, 'enhanced');
  await write(path.join(enhanced, '00-需求引导.md'), `# 增强审核指南

> 审核进度：0/0 已理解；0 需要修改；0 存在疑问；0 个阻塞问题 <!-- review-summary -->

## 需求背景与目标

帮助管理员创建记录。

## 整体用户流程

1. 填写。
2. 提交。

## 功能说明

### 功能点 1：创建记录
<!-- guide-point:PX-REQ-FR001 sync:pending -->

管理员填写数据后创建记录。

- 审核状态：理解一致
- 关键规则：提交合法数据。
- 参考详细文档：
  - <!-- req-link:PX-REQ-FR001 -->

### 功能点 2：名称唯一
<!-- guide-point:PX-REQ-BR001 sync:pending -->

管理员不能创建重名记录。

- 审核状态：需要修改
- 关键规则：名称唯一。
- 参考详细文档：
  - <!-- req-link:PX-REQ-BR001 -->

## 必须确认的问题

### PX-REQ-Q001｜是否通知

- 状态：待确认
- 影响等级：阻塞开发
- 关联需求：PX-REQ-FR001
- 用户答复：
- 已同步：否
`);
  await write(path.join(enhanced, '01-详细需求.md'), `# 详细需求

<a id="px-req-fr001"></a>
### PX-REQ-FR001｜创建记录

- 状态：来源已确认
- 来源：[DOC-01-S001｜创建流程](<_sources/DOC-01.md#doc-01-s001>)

创建记录。

<a id="px-req-br001"></a>
### PX-REQ-BR001｜名称唯一

- 状态：来源已确认
- 来源：[DOC-01-S001｜创建流程](<_sources/DOC-01.md#doc-01-s001>)

名称必须唯一。
`);
  await write(path.join(enhanced, '_sources', '资料索引.md'), '# 资料索引\n\nDOC-01 已读取。\n');
  await write(path.join(enhanced, '_sources', 'DOC-01.md'), `# DOC-01 快照

<a id="doc-01-s001"></a>
## DOC-01-S001｜创建流程

管理员填写信息并创建记录，名称唯一。
`);

  const enhancedBuild = JSON.parse(run(buildScript, enhanced));
  assert.equal(enhancedBuild.guidePoints, 2);
  assert.equal(enhancedBuild.reviewedGuidePoints, 1);
  assert.equal(enhancedBuild.needsChangeGuidePoints, 1);
  assert.equal(enhancedBuild.blockingQuestions, 1);
  assert.equal(enhancedBuild.nextReviewFile, '00-需求引导.md');
  assert.deepEqual(enhancedBuild.nextReviewItems, ['PX-REQ-Q001', 'PX-REQ-BR001']);
  let enhancedGuide = await readFile(path.join(enhanced, '00-需求引导.md'), 'utf8');
  assert.match(enhancedGuide, /guide-point:PX-REQ-FR001 sync:[a-f0-9]{16}/u);
  assert.match(enhancedGuide, /整体审核：1\/2 功能点已理解；1 需要修改/u);
  let enhancedValidation = JSON.parse(run(validateScript, enhanced));
  assert.equal(enhancedValidation.valid, true);
  assert.equal(enhancedValidation.reviewSummary.staleGuidePoints, 0);
  assert.equal(enhancedValidation.unresolvedQuestions, 1);
  assert.equal(enhancedValidation.nextReview.file, '00-需求引导.md');
  assert.equal(enhancedValidation.nextReview.focusItems.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(enhanced, 'requirement-index.json'), 'utf8')).reviewPlan.featureReviewCompleted, true);

  await write(path.join(enhanced, '00-需求引导.md'), enhancedGuide.replace('- 审核状态：需要修改', '- 审核状态：理解一致'));
  const batchConfirmed = JSON.parse(run(buildScript, enhanced));
  assert.equal(batchConfirmed.reviewedGuidePoints, 2);
  assert.equal(batchConfirmed.needsChangeGuidePoints, 0);

  const changedDetail = (await readFile(path.join(enhanced, '01-详细需求.md'), 'utf8')).replace('创建记录。', '创建一条新记录。');
  await write(path.join(enhanced, '01-详细需求.md'), changedDetail);
  const staleBuild = JSON.parse(run(buildScript, enhanced));
  assert.equal(staleBuild.staleGuidePoints, 1);
  enhancedValidation = JSON.parse(run(validateScript, enhanced));
  assert.equal(enhancedValidation.valid, true);
  assert.match(enhancedValidation.warnings.join('\n'), /引导可能未同步/u);

  const acceptedBuild = JSON.parse(run(buildScript, enhanced, true, ['--accept-guide-sync']));
  assert.equal(acceptedBuild.acceptedGuideSync, true);
  assert.equal(acceptedBuild.staleGuidePoints, 0);
  enhancedValidation = JSON.parse(run(validateScript, enhanced));
  assert.equal(enhancedValidation.reviewSummary.staleGuidePoints, 0);

  const shiftedDetail = `说明行。\n\n${await readFile(path.join(enhanced, '01-详细需求.md'), 'utf8')}`;
  await write(path.join(enhanced, '01-详细需求.md'), shiftedDetail);
  assert.equal(JSON.parse(run(buildScript, enhanced)).staleGuidePoints, 0);
  enhancedGuide = await readFile(path.join(enhanced, '00-需求引导.md'), 'utf8');
  assert.match(enhancedGuide, /本机第 6 行/u);

  const missingImpactGuide = enhancedGuide.replace('- 影响等级：阻塞开发\n', '');
  await write(path.join(enhanced, '00-需求引导.md'), missingImpactGuide);
  run(buildScript, enhanced);
  enhancedValidation = JSON.parse(run(validateScript, enhanced));
  assert.equal(enhancedValidation.valid, true);
  assert.match(enhancedValidation.warnings.join('\n'), /缺少影响等级/u);

  await write(path.join(enhanced, '00-需求引导.md'), missingImpactGuide.replace('- 状态：待确认\n', '- 状态：待确认\n- 影响等级：最高优先\n'));
  run(buildScript, enhanced);
  const invalidImpact = run(validateScript, enhanced, false);
  assert.match(invalidImpact, /影响等级无效/u);

  const duplicateSource = `${await readFile(path.join(enhanced, '_sources', 'DOC-01.md'), 'utf8')}\n<a id="doc-01-s001"></a>\n## DOC-01-S001｜重复片段\n`;
  await write(path.join(enhanced, '_sources', 'DOC-01.md'), duplicateSource);
  const sourceReport = run(validateScript, enhanced, false);
  assert.match(sourceReport, /来源片段编号重复/u);

  const missing = path.join(root, 'missing');
  await write(path.join(missing, '00-需求引导.md'), guide());
  const missingReport = run(validateScript, missing, false);
  assert.match(missingReport, /缺少 _sources\/资料索引\.md/u);
  assert.match(missingReport, /需求包必须包含 01-详细需求\.md/u);
  assert.match(missingReport, /缺少 requirement-index\.json/u);

  process.stdout.write('requirements-refiner scripts: all tests passed\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
