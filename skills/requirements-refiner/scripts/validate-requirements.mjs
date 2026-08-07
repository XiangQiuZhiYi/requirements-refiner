#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_QUESTION_IMPACTS,
  ALLOWED_REQUIREMENT_STATUSES,
  ALLOWED_REVIEW_STATUSES,
  buildReviewPlan,
  listGuideFiles,
  listMarkdownFiles,
  scanGuidePoints,
  scanQuestions,
  scanRequirements,
  scanSources,
} from './build-requirement-index.mjs';
import { validateUiCaches } from './ui-context-cache.mjs';

const MANAGED_LINK = /<!--\s*req-link:(P(?:\d+|X)-(?:UC\d+|COM|REQ)-(?:FR|BR|AC)\d{3})\s*-->/gu;
const REVIEW_SUMMARY_MARKER = /<!--\s*review-summary\s*-->/u;
const SOURCE_FRAGMENT_ID = /\b(?:DOC|UI|IMG|USER)-\d{2}-S\d{3}\b/gu;
const LEGACY_SOURCE_ID = /\b(?:DOC|UI|IMG|USER)-\d{2}\b(?!-S\d{3})/gu;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function addUnique(target, message) {
  if (!target.includes(message)) target.push(message);
}

async function validateDocumentShape(rootDir, errors) {
  const guide = path.join(rootDir, '00-需求引导.md');
  const sourceIndex = path.join(rootDir, '_sources', '资料索引.md');
  const singleDetail = path.join(rootDir, '01-详细需求.md');
  const common = path.join(rootDir, '01-公共需求.md');

  if (!(await exists(guide))) errors.push('缺少 00-需求引导.md');
  if (!(await exists(sourceIndex))) errors.push('缺少 _sources/资料索引.md');

  const hasSingle = await exists(singleDetail);
  const hasCommon = await exists(common);
  const rootEntries = await readdir(rootDir, { withFileTypes: true });
  const ucDirs = rootEntries.filter((entry) => entry.isDirectory() && /^UC\d+-/u.test(entry.name));
  const ucDetails = [];
  for (const directory of ucDirs) {
    const detail = path.join(rootDir, directory.name, '详细需求.md');
    const ucGuide = path.join(rootDir, directory.name, '需求引导.md');
    if (await exists(detail)) ucDetails.push(detail);
    else errors.push(`${directory.name} 缺少详细需求.md`);
    if (!(await exists(ucGuide))) errors.push(`${directory.name} 缺少需求引导.md`);
  }

  if (!hasSingle && !(hasCommon && ucDetails.length > 0)) {
    errors.push('需求包必须包含 01-详细需求.md，或同时包含 01-公共需求.md 与至少一个 UCxx-*/详细需求.md');
  }
  if (hasSingle && (hasCommon || ucDetails.length > 0)) errors.push('单体需求和多 UC 目录不能同时存在');
}

async function validateMarkdownLinks(rootDir, filePath, content, errors) {
  const linkExpression = /\[[^\]]+\]\(<([^>]+)>\)/gu;
  for (const match of content.matchAll(linkExpression)) {
    const destination = match[1];
    if (/^[a-z]+:\/\//iu.test(destination)) continue;

    const lineMatch = destination.match(/^(.*):(\d+)$/u);
    if (lineMatch && path.isAbsolute(lineMatch[1])) {
      const target = lineMatch[1];
      if (!(await exists(target))) {
        errors.push(`${path.relative(rootDir, filePath)} 存在失效行号链接：${destination}`);
        continue;
      }
      const targetLines = (await readFile(target, 'utf8')).split(/\r?\n/u).length;
      if (Number(lineMatch[2]) > targetLines) errors.push(`${destination} 超出目标文件行数 ${targetLines}`);
      continue;
    }

    const [filePart, anchor] = destination.split('#', 2);
    const target = path.resolve(path.dirname(filePath), filePart || path.basename(filePath));
    if (!(await exists(target))) {
      errors.push(`${path.relative(rootDir, filePath)} 存在失效链接：${destination}`);
      continue;
    }
    if (anchor) {
      const targetContent = await readFile(target, 'utf8');
      const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const anchorExpression = new RegExp(`<a\\s+id=["']${escaped}["']\\s*><\\/a>`, 'iu');
      if (!anchorExpression.test(targetContent)) errors.push(`${destination} 的锚点不存在`);
    }
  }
}

function validateUniqueIds(items, label, errors) {
  const seen = new Map();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      const previous = seen.get(item.id);
      errors.push(`${label}编号重复：${item.id} 出现在 ${previous.file}:${previous.line} 和 ${item.file}:${item.line}`);
    } else {
      seen.set(item.id, item);
    }
  }
  return seen;
}

function sameSummary(actual, indexed) {
  const keys = ['total', 'understood', 'needsChange', 'hasQuestions', 'unreviewed', 'blockingQuestions', 'staleGuidePoints'];
  return keys.every((key) => actual?.[key] === indexed?.[key]);
}

function summarize(points, questions) {
  const count = (status) => points.filter((item) => item.reviewStatus === status).length;
  return {
    total: points.length,
    understood: count('理解一致'),
    needsChange: count('需要修改'),
    hasQuestions: count('存在疑问'),
    unreviewed: count('未审核'),
    blockingQuestions: questions.filter((item) => item.status === '待确认' && item.impact === '阻塞开发').length,
    staleGuidePoints: points.filter((item) => item.syncStatus === 'possibly_stale').length,
  };
}

async function validateRequirementPackage(rootDir, reviewSummary, uiManifests, errors, warnings) {
  const packagePath = path.join(rootDir, 'requirement-package.json');
  if (!(await exists(packagePath))) {
    addUnique(warnings, '缺少 requirement-package.json，请重新构建索引以生成开发交接入口');
    return;
  }
  try {
    const requirementPackage = JSON.parse(await readFile(packagePath, 'utf8'));
    if (requirementPackage.schemaVersion !== 1) errors.push(`requirement-package.json schemaVersion 应为 1，当前为 ${requirementPackage.schemaVersion ?? '空'}`);
    if (!requirementPackage.requirement?.name) errors.push('requirement-package.json 缺少需求名称');
    if (!requirementPackage.requirement?.stage) errors.push('requirement-package.json 缺少阶段');
    for (const [label, relative] of [
      ['需求引导', requirementPackage.documents?.guide],
      ['需求索引', requirementPackage.documents?.requirementIndex],
      ...((requirementPackage.documents?.details ?? []).map((item) => ['详细需求', item])),
    ]) {
      if (!relative || path.isAbsolute(relative)) {
        errors.push(`requirement-package.json ${label}路径必须是相对路径`);
        continue;
      }
      if (!(await exists(path.resolve(rootDir, relative)))) errors.push(`requirement-package.json ${label}文件不存在：${relative}`);
    }
    if (!sameSummary(reviewSummary, requirementPackage.reviewSummary)) errors.push('requirement-package.json 的 reviewSummary 已过期，请重新构建索引');
    const packageArtifacts = new Map((requirementPackage.sourceArtifacts ?? []).map((item) => [item.id, item]));
    for (const manifest of uiManifests) {
      const artifact = packageArtifacts.get(manifest.sourceId);
      if (!artifact) errors.push(`requirement-package.json 缺少 UI 缓存 ${manifest.sourceId}`);
      else if (artifact.status !== manifest.status || artifact.fetchedSections !== manifest.fetchedSections || artifact.manifest !== `./${manifest.manifest}`) {
        errors.push(`requirement-package.json 的 ${manifest.sourceId} 缓存状态已过期`);
      }
    }
    for (const id of packageArtifacts.keys()) {
      if (!uiManifests.some((item) => item.sourceId === id)) errors.push(`requirement-package.json 引用了不存在的 UI 缓存：${id}`);
    }
  } catch (error) {
    errors.push(`requirement-package.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateRequirements(rootInput) {
  const rootDir = path.resolve(rootInput);
  const errors = [];
  const warnings = [];
  await validateDocumentShape(rootDir, errors);

  const requirements = await scanRequirements(rootDir);
  const byId = validateUniqueIds(requirements, '需求', errors);
  const sources = await scanSources(rootDir);
  const sourceById = validateUniqueIds(sources, '来源片段', errors);
  const guidePoints = await scanGuidePoints(rootDir, requirements);
  const guidePointById = validateUniqueIds(guidePoints.filter((item) => item.id), '功能点', errors);
  const questions = await scanQuestions(rootDir);
  validateUniqueIds(questions, '审核问题', errors);
  const uiCacheReport = await validateUiCaches(rootDir);
  errors.push(...uiCacheReport.errors);
  warnings.push(...uiCacheReport.warnings);
  const hasUiSources = sources.some((item) => item.id.startsWith('UI-'));
  if (hasUiSources && uiCacheReport.manifests.length === 0) {
    addUnique(warnings, '需求包含 UI 来源，但没有登记完整 UI 原始缓存');
  }
  for (const source of sources.filter((item) => item.id.startsWith('UI-'))) {
    const sourceId = source.id.match(/^UI-\d{2}/u)?.[0];
    const manifest = uiCacheReport.manifests.find((item) => item.sourceId === sourceId);
    if (manifest && manifest.status !== 'missing' && !(uiCacheReport.sourceMaps[sourceId] ?? []).includes(source.id)) {
      addUnique(warnings, `${source.id} 尚未映射到原始 UI 分区或节点`);
    }
  }

  for (const item of requirements) {
    if (!item.anchorPresent) errors.push(`${item.file}:${item.line} 缺少锚点 <a id="${item.anchor}"></a>`);
    if (!ALLOWED_REQUIREMENT_STATUSES.has(item.status)) {
      errors.push(`${item.file}:${item.line} 状态无效或缺失：${item.status || '空'}`);
    }
    if (!item.source || /^(?:\{\{.*\}\}|待补充|待确认)$/u.test(item.source)) {
      errors.push(`${item.file}:${item.line} 来源缺失`);
    }
    if ((item.status === '来源已确认' || item.status === '用户已确认') && /^无(?:[；;]|$)/u.test(item.source)) {
      errors.push(`${item.file}:${item.line} 已确认需求不能使用“无”作为来源`);
    }
    const sourceIds = [...item.source.matchAll(SOURCE_FRAGMENT_ID)].map((match) => match[0]);
    for (const sourceId of sourceIds) {
      if (!sourceById.has(sourceId)) errors.push(`${item.file}:${item.line} 引用了不存在的来源片段：${sourceId}`);
    }
    const legacyIds = [...item.source.matchAll(LEGACY_SOURCE_ID)].map((match) => match[0]);
    if (legacyIds.length > 0 && sourceIds.length === 0) {
      addUnique(warnings, `${item.file}:${item.line} 来源定位仍较粗：${[...new Set(legacyIds)].join('、')}`);
    }
  }

  for (const source of sources) {
    if (!source.anchorPresent) errors.push(`${source.file}:${source.line} 缺少来源锚点 <a id="${source.anchor}"></a>`);
  }

  const markdownFiles = await listMarkdownFiles(rootDir);
  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, 'utf8');
    if (content.includes('{{')) errors.push(`${path.relative(rootDir, filePath)} 仍包含模板占位符`);
    await validateMarkdownLinks(rootDir, filePath, content, errors);
  }

  const guidePath = path.join(rootDir, '00-需求引导.md');
  const guideFiles = await listGuideFiles(rootDir);
  if (await exists(guidePath)) {
    const guide = await readFile(guidePath, 'utf8');
    const guideSections = [
      { label: '需求背景与目标', pattern: /^##\s+.*(?:需求背景|背景与目标)/mu },
      { label: '整体用户流程', pattern: /^##\s+.*(?:整体.*流程|用户流程)/mu },
      { label: '功能或 UC 说明', pattern: /^##\s+.*(?:功能.*说明|UC.*(?:说明|总览|审核入口))/mu },
    ];
    for (const section of guideSections) {
      if (!section.pattern.test(guide)) errors.push(`00-需求引导.md 缺少可独立阅读所需的“${section.label}”章节`);
    }
  }

  for (const currentGuide of guideFiles) {
    const relativeGuide = path.relative(rootDir, currentGuide).split(path.sep).join('/');
    const guide = await readFile(currentGuide, 'utf8');
    if (!REVIEW_SUMMARY_MARKER.test(guide)) addUnique(warnings, `${relativeGuide} 缺少受管审核摘要，建议迁移`);
    if (path.basename(currentGuide) === '需求引导.md') {
      const ucSections = [
        { label: '需求概述', pattern: /^##\s+.*需求概述/mu },
        { label: '使用流程', pattern: /^##\s+.*(?:使用流程|主要流程)/mu },
        { label: '功能点说明', pattern: /^##\s+.*功能点.*说明/mu },
      ];
      for (const section of ucSections) {
        if (!section.pattern.test(guide)) errors.push(`${relativeGuide} 缺少“${section.label}”章节`);
      }
      if (!/^###\s+功能点\s*\d+[：:]/mu.test(guide)) errors.push(`${relativeGuide} 未按“功能点 N：名称”展开需求`);
    }
    for (const match of guide.matchAll(MANAGED_LINK)) {
      if (!byId.has(match[1])) errors.push(`${relativeGuide} 引用了不存在的需求编号：${match[1]}`);
    }
  }

  for (const point of guidePoints) {
    if (point.markerMissing) {
      addUnique(warnings, `${point.file}:${point.line} 功能点缺少 guide-point 标记，暂不检测同步漂移`);
      continue;
    }
    if (!ALLOWED_REVIEW_STATUSES.has(point.reviewStatus)) {
      errors.push(`${point.file}:${point.line} 功能点审核状态无效：${point.reviewStatus || '空'}`);
    } else if (point.reviewStatusMissing) {
      addUnique(warnings, `${point.file}:${point.line} 功能点缺少审核状态，按“未审核”处理`);
    }
    if (point.relatedRequirementIds.length === 0) {
      errors.push(`${point.file}:${point.line} 功能点没有关联详细需求`);
    }
    if (point.id && !point.relatedRequirementIds.includes(point.id)) {
      errors.push(`${point.file}:${point.line} guide-point 主编号 ${point.id} 未出现在参考详细文档中`);
    }
    if (point.id && !byId.has(point.id)) errors.push(`${point.file}:${point.line} guide-point 主编号不存在：${point.id}`);
    if (point.syncStatus === 'possibly_stale') {
      addUnique(warnings, `${point.file}:${point.line} ${point.id} 关联详细需求已变化，引导可能未同步`);
    } else if (point.syncStatus === 'untracked') {
      addUnique(warnings, `${point.file}:${point.line} ${point.id || point.title} 尚未建立同步基线`);
    }
  }

  for (const question of questions) {
    if (!['待确认', '已解决'].includes(question.status)) {
      errors.push(`${question.file}:${question.line} 审核问题状态无效：${question.status || '空'}`);
    }
    if (!question.impact) {
      addUnique(warnings, `${question.file}:${question.line} 审核问题 ${question.id} 缺少影响等级`);
    } else if (!ALLOWED_QUESTION_IMPACTS.has(question.impact)) {
      errors.push(`${question.file}:${question.line} 审核问题影响等级无效：${question.impact}`);
    }
    if (question.related && !byId.has(question.related)) {
      errors.push(`${question.file}:${question.line} 关联需求不存在：${question.related}`);
    }
    if (question.status === '已解决' && question.synced !== '是') errors.push(`审核问题 ${question.id} 已解决但未同步到详细需求`);
    if (question.answer && question.status !== '已解决') {
      errors.push(`审核问题 ${question.id} 已填写用户答复但状态仍为 ${question.status || '空'}`);
    }
    if (question.status === '待确认') {
      addUnique(warnings, `待确认：${question.id}｜${question.title}｜${question.impact || '未分级'}（${question.file}）`);
    }
  }

  const sourceIndexPath = path.join(rootDir, '_sources', '资料索引.md');
  if (await exists(sourceIndexPath)) {
    const sourceIndex = await readFile(sourceIndexPath, 'utf8');
    if (sourceIndex.includes('{{')) errors.push('_sources/资料索引.md 仍包含模板占位符');
    if (!/(?:DOC|UI|IMG|USER)-\d{2}/u.test(sourceIndex)) errors.push('_sources/资料索引.md 未包含任何稳定来源编号');
  }

  const reviewSummary = summarize(guidePoints, questions);
  await validateRequirementPackage(rootDir, reviewSummary, uiCacheReport.manifests, errors, warnings);
  const indexPath = path.join(rootDir, 'requirement-index.json');
  if (!(await exists(indexPath))) {
    errors.push('缺少 requirement-index.json，请先运行 build-requirement-index.mjs');
  } else {
    try {
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      if (index.schemaVersion !== 2) errors.push(`requirement-index.json schemaVersion 应为 2，当前为 ${index.schemaVersion ?? '空'}`);
      const indexedRequirements = new Map((index.requirements ?? []).map((item) => [item.id, item]));
      for (const item of requirements) {
        const indexed = indexedRequirements.get(item.id);
        if (!indexed) errors.push(`索引缺少 ${item.id}`);
        else if (indexed.file !== item.file || indexed.line !== item.line || indexed.status !== item.status || indexed.contentFingerprint !== item.contentFingerprint) {
          errors.push(`索引中的 ${item.id} 已过期，请重新构建索引`);
        }
      }
      for (const id of indexedRequirements.keys()) if (!byId.has(id)) errors.push(`索引包含已不存在的需求编号：${id}`);

      const indexedPoints = new Map((index.guidePoints ?? []).filter((item) => item.id).map((item) => [item.id, item]));
      for (const [id, point] of guidePointById) {
        const indexed = indexedPoints.get(id);
        if (!indexed || indexed.reviewStatus !== point.reviewStatus || indexed.currentFingerprint !== point.currentFingerprint || indexed.syncStatus !== point.syncStatus) {
          errors.push(`索引中的功能点 ${id} 已过期，请重新构建索引`);
        }
      }

      const indexedSources = new Map((index.sources ?? []).map((item) => [item.id, item]));
      for (const [id, source] of sourceById) {
        const indexed = indexedSources.get(id);
        if (!indexed || indexed.file !== source.file || indexed.line !== source.line) errors.push(`索引中的来源片段 ${id} 已过期`);
      }
      const indexedArtifacts = new Map((index.sourceArtifacts ?? []).map((item) => [item.sourceId, item]));
      for (const manifest of uiCacheReport.manifests) {
        const indexed = indexedArtifacts.get(manifest.sourceId);
        if (!indexed || indexed.status !== manifest.status || indexed.fetchedSections !== manifest.fetchedSections || indexed.manifest !== manifest.manifest) {
          errors.push(`索引中的 UI 缓存 ${manifest.sourceId} 已过期，请重新构建索引`);
        }
      }
      for (const id of indexedArtifacts.keys()) {
        if (!uiCacheReport.manifests.some((item) => item.sourceId === id)) errors.push(`索引包含已不存在的 UI 缓存：${id}`);
      }
      if (!sameSummary(reviewSummary, index.reviewSummary)) errors.push('索引中的 reviewSummary 已过期，请重新构建索引');
      const reviewPlan = buildReviewPlan(guidePoints, questions);
      if (JSON.stringify(reviewPlan) !== JSON.stringify(index.reviewPlan)) {
        errors.push('索引中的 reviewPlan 已过期，请重新构建索引');
      }
    } catch (error) {
      errors.push(`requirement-index.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    root: rootDir,
    valid: errors.length === 0,
    requirements: requirements.length,
    guidePoints: guidePoints.length,
    reviewSummary,
    nextReview: buildReviewPlan(guidePoints, questions).next,
    unresolvedQuestions: questions.filter((item) => item.status === '待确认').length,
    uiCaches: uiCacheReport.manifests.map((item) => ({
      id: item.sourceId,
      status: item.status,
      fetchedSections: item.fetchedSections,
      expectedSections: item.expectedSections,
    })),
    errors,
    warnings,
  };
}

async function main() {
  const rootDir = process.argv[2];
  if (!rootDir) {
    process.stderr.write('用法: node validate-requirements.mjs <需求包目录>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await validateRequirements(rootDir);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
