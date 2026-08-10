#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUiCacheManifests } from './ui-context-cache.mjs';

export const ALLOWED_REQUIREMENT_STATUSES = new Set([
  '来源已确认',
  '用户已确认',
  '推断待确认',
  '来源冲突',
  '信息缺失',
]);

export const ALLOWED_REVIEW_STATUSES = new Set([
  '未审核',
  '理解一致',
  '需要修改',
  '存在疑问',
]);

export const ALLOWED_QUESTION_IMPACTS = new Set([
  '阻塞开发',
  '影响验收',
  '可后补充',
]);

const REQUIREMENT_ID = 'P(?:\\d+|X)-(?:UC\\d+|COM|REQ)-(?:FR|BR|AC)\\d{3}';
const REQUIREMENT_HEADING = new RegExp(`^(#{2,6})\\s+(${REQUIREMENT_ID})[｜|]\\s*(.+?)\\s*$`, 'u');
const QUESTION_HEADING = /^(#{2,6})\s+(P(?:\d+|X)-(?:UC\d+|COM|REQ)-Q\d{3})[｜|]\s*(.+?)\s*$/u;
const FUNCTION_HEADING = /^###\s+功能点\s*(\d+)[：:]\s*(.+?)\s*$/u;
const ANY_HEADING = /^(#{1,6})\s+/u;
const LINK_MARKER = new RegExp(`<!--\\s*req-link:(${REQUIREMENT_ID})\\s*-->`, 'u');
const GUIDE_POINT_MARKER = new RegExp(`<!--\\s*guide-point:(${REQUIREMENT_ID})(?:\\s+sync:([a-f0-9]{8,64}|pending))?\\s*-->`, 'u');
const SOURCE_HEADING = /^(#{1,6})\s+((?:DOC|UI|IMG|USER)-\d{2}-S\d{3})[｜|]\s*(.+?)\s*$/u;
const REVIEW_SUMMARY_MARKER = /<!--\s*review-summary\s*-->/u;

function normalizeText(value) {
  return value
    .replace(/\r/gu, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function fingerprint(value) {
  return createHash('sha256').update(normalizeText(value), 'utf8').digest('hex').slice(0, 16);
}

function headingLevel(line) {
  return line.match(/^(#{1,6})\s+/u)?.[1].length ?? 0;
}

function blockEnd(lines, start, level) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLevel = headingLevel(lines[index]);
    if (nextLevel > 0 && nextLevel <= level) return index;
  }
  return lines.length;
}

export function fieldFromBlock(lines, start, end, key) {
  const expression = new RegExp(`^\\s*(?:-\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?[：:]\\s*(.*?)\\s*$`, 'u');
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(expression);
    if (match) return match[1];
  }
  return '';
}

function readRequirementMetadata(lines, startLine, endLine) {
  return {
    status: fieldFromBlock(lines, startLine, endLine, '状态'),
    source: fieldFromBlock(lines, startLine, endLine, '来源'),
  };
}

async function listFilesRecursively(rootDir, predicate, skipDirectories = new Set()) {
  const results = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.isDirectory() && (skipDirectories.has(entry.name) || entry.name.startsWith('.'))) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && predicate(entry.name, fullPath)) results.push(fullPath);
    }
  }
  await walk(rootDir);
  return results;
}

export async function listMarkdownFiles(rootDir) {
  return listFilesRecursively(
    rootDir,
    (name) => name.endsWith('.md'),
    new Set(['_sources', 'node_modules']),
  );
}

export async function scanRequirements(rootDir) {
  const files = await listMarkdownFiles(rootDir);
  const requirements = [];

  for (const filePath of files) {
    if (['00-需求引导.md', '需求引导.md'].includes(path.basename(filePath))) continue;
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(REQUIREMENT_HEADING);
      if (!match) continue;
      const id = match[2];
      const level = match[1].length;
      const end = blockEnd(lines, index, level);
      const anchor = id.toLowerCase();
      const anchorPattern = new RegExp(`<a\\s+id=["']${anchor}["']\\s*><\\/a>`, 'iu');
      const anchorWindow = lines.slice(Math.max(0, index - 3), index).join('\n');
      const { status, source } = readRequirementMetadata(lines, index + 1, end);
      const body = normalizeText(lines.slice(index + 1, end).join('\n'));
      const contentFingerprint = fingerprint(JSON.stringify({ id, title: match[3], status, source, body }));
      requirements.push({
        id,
        title: match[3],
        type: id.match(/-(FR|BR|AC)\d{3}$/u)?.[1] ?? '',
        status,
        source,
        file: path.relative(rootDir, filePath).split(path.sep).join('/'),
        absoluteFile: path.resolve(filePath),
        line: index + 1,
        anchor,
        anchorPresent: anchorPattern.test(anchorWindow),
        contentFingerprint,
      });
    }
  }

  return requirements;
}

export async function listGuideFiles(rootDir) {
  const guideFiles = [];
  const rootGuide = path.join(rootDir, '00-需求引导.md');
  try {
    await readFile(rootGuide, 'utf8');
    guideFiles.push(rootGuide);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^UC\d+-/u.test(entry.name)) continue;
    const ucGuide = path.join(rootDir, entry.name, '需求引导.md');
    try {
      await readFile(ucGuide, 'utf8');
      guideFiles.push(ucGuide);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return guideFiles;
}

export function scanQuestionsFromContent(content, file = '') {
  const lines = content.split(/\r?\n/u);
  const questions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(QUESTION_HEADING);
    if (!match) continue;
    const end = blockEnd(lines, index, match[1].length);
    questions.push({
      id: match[2],
      title: match[3],
      file,
      line: index + 1,
      status: fieldFromBlock(lines, index + 1, end, '状态'),
      impact: fieldFromBlock(lines, index + 1, end, '影响等级'),
      related: fieldFromBlock(lines, index + 1, end, '关联需求'),
      answer: fieldFromBlock(lines, index + 1, end, '用户答复'),
      synced: fieldFromBlock(lines, index + 1, end, '已同步'),
    });
  }
  return questions;
}

function guidePointFingerprint(relatedIds, byId) {
  if (relatedIds.length === 0 || relatedIds.some((id) => !byId.has(id))) return '';
  return fingerprint(relatedIds.map((id) => `${id}:${byId.get(id).contentFingerprint}`).join('\n'));
}

export function scanGuidePointsFromContent(content, file, requirements) {
  const byId = new Map(requirements.map((item) => [item.id, item]));
  const lines = content.split(/\r?\n/u);
  const points = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(FUNCTION_HEADING);
    if (!heading) continue;
    const end = blockEnd(lines, index, 3);
    const blockLines = lines.slice(index + 1, end);
    const markerLineOffset = blockLines.findIndex((line) => GUIDE_POINT_MARKER.test(line));
    const marker = markerLineOffset >= 0 ? blockLines[markerLineOffset].match(GUIDE_POINT_MARKER) : null;
    const relatedRequirementIds = [];
    for (const line of blockLines) {
      const link = line.match(LINK_MARKER);
      if (link && !relatedRequirementIds.includes(link[1])) relatedRequirementIds.push(link[1]);
    }
    const currentFingerprint = guidePointFingerprint(relatedRequirementIds, byId);
    const baselineFingerprint = marker?.[2] && marker[2] !== 'pending' ? marker[2] : '';
    points.push({
      id: marker?.[1] ?? '',
      number: Number(heading[1]),
      title: heading[2],
      file,
      line: index + 1,
      markerLine: markerLineOffset >= 0 ? index + 2 + markerLineOffset : 0,
      markerMissing: !marker,
      reviewStatus: fieldFromBlock(lines, index + 1, end, '审核状态') || '未审核',
      reviewStatusMissing: !fieldFromBlock(lines, index + 1, end, '审核状态'),
      userOpinion: fieldFromBlock(lines, index + 1, end, '用户意见'),
      relatedRequirementIds,
      baselineFingerprint,
      currentFingerprint,
      syncStatus: !marker || !baselineFingerprint || !currentFingerprint
        ? 'untracked'
        : baselineFingerprint === currentFingerprint ? 'synced' : 'possibly_stale',
    });
  }
  return points;
}

export async function scanGuidePoints(rootDir, requirements) {
  const points = [];
  for (const guidePath of await listGuideFiles(rootDir)) {
    const file = path.relative(rootDir, guidePath).split(path.sep).join('/');
    points.push(...scanGuidePointsFromContent(await readFile(guidePath, 'utf8'), file, requirements));
  }
  return points;
}

export async function scanQuestions(rootDir) {
  const questions = [];
  for (const guidePath of await listGuideFiles(rootDir)) {
    const file = path.relative(rootDir, guidePath).split(path.sep).join('/');
    questions.push(...scanQuestionsFromContent(await readFile(guidePath, 'utf8'), file));
  }
  return questions;
}

export async function scanSources(rootDir) {
  const sourceRoot = path.join(rootDir, '_sources');
  let files;
  try {
    files = await listFilesRecursively(sourceRoot, (name) => name.endsWith('.md'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const sources = [];
  for (const filePath of files) {
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(SOURCE_HEADING);
      if (!match) continue;
      const anchor = match[2].toLowerCase();
      const anchorPattern = new RegExp(`<a\\s+id=["']${anchor}["']\\s*><\\/a>`, 'iu');
      const anchorWindow = lines.slice(Math.max(0, index - 3), index).join('\n');
      sources.push({
        id: match[2],
        title: match[3],
        file: path.relative(rootDir, filePath).split(path.sep).join('/'),
        absoluteFile: path.resolve(filePath),
        line: index + 1,
        anchor,
        anchorPresent: anchorPattern.test(anchorWindow),
      });
    }
  }
  return sources;
}

function assertNoDuplicates(items, label) {
  const seen = new Map();
  const duplicates = [];
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) duplicates.push(`${item.id}: ${seen.get(item.id)} 与 ${item.file}:${item.line}`);
    else seen.set(item.id, `${item.file}:${item.line}`);
  }
  if (duplicates.length > 0) throw new Error(`发现重复${label}编号：\n${duplicates.join('\n')}`);
}

function relativeLink(fromFile, toFile, anchor) {
  let relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return `${relative}#${anchor}`;
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

function reviewItemPriority(item) {
  if (item.kind === 'question') {
    if (item.impact === '阻塞开发') return 0;
    if (item.impact === '影响验收' || !item.impact) return 2;
    return 6;
  }
  if (item.reviewStatus === '需要修改') return 1;
  if (item.reviewStatus === '存在疑问') return 3;
  if (item.syncStatus === 'possibly_stale') return 4;
  return 5;
}

function reviewItemReason(item) {
  if (item.kind === 'question') return item.impact || '问题未分级';
  if (item.reviewStatus === '需要修改') return '需要修改';
  if (item.reviewStatus === '存在疑问') return '存在疑问';
  if (item.syncStatus === 'possibly_stale') return '可能未同步';
  return '尚未审核';
}

function reviewGroupLabel(file) {
  if (file === '00-需求引导.md') return '整体需求';
  const match = file.match(/^(UC\d+)-([^/]+)\/需求引导\.md$/u);
  if (match) return `${match[1]} ${match[2]}`;
  return file.replace(/\/需求引导\.md$/u, '').replace(/\.md$/u, '');
}

function reviewGroupPosition(file) {
  if (file === '00-需求引导.md') return [0, 0, file];
  const match = file.match(/^UC(\d+)-/u);
  if (match) return [1, Number(match[1]), file];
  return [2, 0, file];
}

function compareReviewGroups(left, right) {
  const leftPosition = reviewGroupPosition(left.file);
  const rightPosition = reviewGroupPosition(right.file);
  return leftPosition[0] - rightPosition[0]
    || leftPosition[1] - rightPosition[1]
    || leftPosition[2].localeCompare(rightPosition[2], 'zh-CN');
}

export function buildReviewPlan(points, questions) {
  const items = [];
  for (const question of questions) {
    if (question.status !== '待确认') continue;
    const item = {
      kind: 'question',
      id: question.id,
      title: question.title,
      file: question.file,
      line: question.line,
      impact: question.impact,
    };
    item.priority = reviewItemPriority(item);
    item.reason = reviewItemReason(item);
    items.push(item);
  }
  for (const point of points) {
    if (point.reviewStatus === '理解一致' && point.syncStatus !== 'possibly_stale') continue;
    const item = {
      kind: 'guidePoint',
      id: point.id,
      number: point.number,
      title: point.title,
      file: point.file,
      line: point.line,
      reviewStatus: point.reviewStatus,
      syncStatus: point.syncStatus,
    };
    item.priority = reviewItemPriority(item);
    item.reason = reviewItemReason(item);
    items.push(item);
  }

  items.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN')
    || a.priority - b.priority
    || a.line - b.line
    || a.id.localeCompare(b.id));

  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.file)) grouped.set(item.file, []);
    grouped.get(item.file).push(item);
  }
  const groups = [...grouped.entries()].map(([file, groupItems]) => {
    groupItems.sort((a, b) => a.priority - b.priority || a.line - b.line || a.id.localeCompare(b.id));
    const features = points
      .filter((item) => item.file === file)
      .sort((a, b) => a.line - b.line)
      .map((item) => ({ id: item.id, number: item.number, title: item.title, reviewStatus: item.reviewStatus }));
    const pendingQuestions = questions
      .filter((item) => item.file === file && item.status === '待确认')
      .sort((a, b) => a.line - b.line)
      .map((item) => ({ id: item.id, title: item.title, impact: item.impact, related: item.related }));
    const unreviewedGuidePoints = groupItems.filter((item) => item.kind === 'guidePoint' && item.reviewStatus === '未审核').length;
    const exceptionalItems = groupItems.filter((item) => item.kind === 'question' || item.reason !== '尚未审核');
    const autoConfirmBlockers = groupItems.filter((item) => item.kind === 'guidePoint'
      && (['需要修改', '存在疑问'].includes(item.reviewStatus) || item.syncStatus === 'possibly_stale'));
    return {
      file,
      label: reviewGroupLabel(file),
      priority: groupItems[0].reason,
      pendingItems: groupItems.length,
      featureCount: features.length,
      features,
      pendingQuestionCount: pendingQuestions.length,
      pendingQuestions,
      unreviewedGuidePoints,
      batchConfirmSuggested: unreviewedGuidePoints > 0,
      readyToAutoConfirm: pendingQuestions.length === 0 && autoConfirmBlockers.length === 0 && unreviewedGuidePoints > 0,
      focusItems: exceptionalItems.slice(0, 3),
      itemIds: groupItems.map((item) => item.id),
    };
  }).sort(compareReviewGroups);

  return {
    startFile: '00-需求引导.md',
    featureReviewCompleted: points.every((item) => item.reviewStatus !== '未审核'),
    completed: groups.length === 0,
    next: groups[0] ?? null,
    groups,
  };
}

async function resolveReviewGuide(rootDir, target) {
  const guidePaths = await listGuideFiles(rootDir);
  const candidates = guidePaths.map((guidePath) => ({
    absolute: guidePath,
    relative: path.relative(rootDir, guidePath).split(path.sep).join('/'),
  }));
  const normalized = String(target ?? '').trim().replace(/\\/gu, '/');
  let matched = candidates.find((item) => item.relative === normalized || item.relative === normalized.replace(/^\.\//u, ''));
  const uc = normalized.match(/(?:P(?:\d+|X)-)?(UC\d+)/iu)?.[1]?.toUpperCase();
  if (!matched && uc) matched = candidates.find((item) => item.relative.startsWith(`${uc}-`));
  if (!matched && /^(?:REQ|单体|整体|00)$/iu.test(normalized)) matched = candidates.find((item) => item.relative === '00-需求引导.md');
  if (!matched) throw new Error(`找不到审核组：${target}`);
  return matched;
}

export async function confirmResolvedReviewGroup(rootInput, target, requirements = null) {
  const rootDir = path.resolve(rootInput);
  const guide = await resolveReviewGuide(rootDir, target);
  const original = await readFile(guide.absolute, 'utf8');
  const questions = scanQuestionsFromContent(original, guide.relative);
  const unresolved = questions.filter((item) => item.status !== '已解决' || item.synced !== '是');
  if (unresolved.length > 0) {
    throw new Error(`${reviewGroupLabel(guide.relative)} 仍有未解决或未同步问题：${unresolved.map((item) => item.id).join('、')}`);
  }
  const requirementItems = requirements ?? await scanRequirements(rootDir);
  const points = scanGuidePointsFromContent(original, guide.relative, requirementItems);
  if (points.length === 0) throw new Error(`${reviewGroupLabel(guide.relative)} 没有可确认的功能点`);
  const blockers = points.filter((item) => ['需要修改', '存在疑问'].includes(item.reviewStatus) || item.syncStatus === 'possibly_stale');
  if (blockers.length > 0) {
    throw new Error(`${reviewGroupLabel(guide.relative)} 仍有未完成修改、疑问或同步漂移：${blockers.map((item) => item.id || item.title).join('、')}`);
  }
  const lines = original.split(/\r?\n/u);
  const confirmed = [];
  for (const point of [...points].sort((left, right) => right.line - left.line)) {
    const headingIndex = point.line - 1;
    const end = blockEnd(lines, headingIndex, 3);
    let statusFound = false;
    for (let cursor = headingIndex + 1; cursor < end; cursor += 1) {
      const status = lines[cursor].match(/^(\s*(?:-\s*)?(?:\*\*)?审核状态(?:\*\*)?[：:]\s*)(.*?)\s*$/u);
      if (!status) continue;
      statusFound = true;
      if (status[2] === '未审核') {
        lines[cursor] = `${status[1]}理解一致`;
        confirmed.push(point.id || point.title);
      }
      break;
    }
    if (!statusFound) {
      const preferred = lines.findIndex((line, index) => index > headingIndex && index < end && /^\s*-\s*(?:关键规则|审核重点|参考详细文档)[：:]/u.test(line));
      lines.splice(preferred >= 0 ? preferred : end, 0, '- 审核状态：理解一致');
      confirmed.push(point.id || point.title);
    }
  }
  const next = lines.join('\n');
  if (next !== original) await writeFile(guide.absolute, next, 'utf8');
  return {
    file: guide.relative,
    label: reviewGroupLabel(guide.relative),
    confirmedPoints: confirmed,
    alreadyUnderstood: points.filter((item) => item.reviewStatus === '理解一致').length,
  };
}

function summaryLine(summary, isRoot) {
  const label = isRoot ? '整体审核' : '审核进度';
  return `> ${label}：${summary.understood}/${summary.total} 功能点已理解；${summary.needsChange} 需要修改；${summary.hasQuestions} 存在疑问；${summary.blockingQuestions} 个阻塞问题 <!-- review-summary -->`;
}

async function refreshGuideLinksAndFingerprints(rootDir, requirements, acceptGuideSync) {
  const byId = new Map(requirements.map((item) => [item.id, item]));
  const missingIds = new Set();
  const updatedFiles = new Set();
  const guideFiles = await listGuideFiles(rootDir);

  for (const guidePath of guideFiles) {
    const original = await readFile(guidePath, 'utf8');
    const lines = original.split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
      const marker = lines[index].match(LINK_MARKER);
      if (!marker) continue;
      const item = byId.get(marker[1]);
      if (!item) {
        missingIds.add(marker[1]);
        continue;
      }
      const indent = lines[index].match(/^\s*/u)?.[0] ?? '';
      const portable = relativeLink(guidePath, item.absoluteFile, item.anchor);
      const local = `${item.absoluteFile}:${item.line}`;
      lines[index] = `${indent}- [${item.id}｜${item.title}](<${portable}>) · [本机第 ${item.line} 行](<${local}>) <!-- req-link:${item.id} -->`;
    }

    const linkedContent = lines.join('\n');
    const relativeGuide = path.relative(rootDir, guidePath).split(path.sep).join('/');
    const points = scanGuidePointsFromContent(linkedContent, relativeGuide, requirements);
    for (const point of points) {
      if (!point.markerLine || !point.currentFingerprint) continue;
      if (!acceptGuideSync && point.baselineFingerprint) continue;
      const markerIndex = point.markerLine - 1;
      lines[markerIndex] = lines[markerIndex].replace(
        GUIDE_POINT_MARKER,
        `<!-- guide-point:${point.id} sync:${point.currentFingerprint} -->`,
      );
    }

    const next = lines.join('\n');
    if (next !== original) {
      await writeFile(guidePath, next, 'utf8');
      updatedFiles.add(relativeGuide);
    }
  }

  return { updatedFiles, missingIds: [...missingIds] };
}

async function refreshReviewSummaries(rootDir, requirements, updatedFiles) {
  const points = await scanGuidePoints(rootDir, requirements);
  const questions = await scanQuestions(rootDir);
  for (const guidePath of await listGuideFiles(rootDir)) {
    const relativeGuide = path.relative(rootDir, guidePath).split(path.sep).join('/');
    const isRoot = path.basename(guidePath) === '00-需求引导.md';
    const guidePoints = isRoot ? points : points.filter((item) => item.file === relativeGuide);
    const guideQuestions = isRoot ? questions : questions.filter((item) => item.file === relativeGuide);
    const original = await readFile(guidePath, 'utf8');
    const replacement = summaryLine(summarize(guidePoints, guideQuestions), isRoot);
    const lines = original.split(/\r?\n/u);
    const markerIndex = lines.findIndex((line) => REVIEW_SUMMARY_MARKER.test(line));
    if (markerIndex < 0) continue;
    lines[markerIndex] = replacement;
    const next = lines.join('\n');
    if (next !== original) {
      await writeFile(guidePath, next, 'utf8');
      updatedFiles.add(relativeGuide);
    }
  }
}

export async function refreshGuideLinks(rootDir, requirements, options = {}) {
  const result = await refreshGuideLinksAndFingerprints(rootDir, requirements, options.acceptGuideSync ?? false);
  await refreshReviewSummaries(rootDir, requirements, result.updatedFiles);
  return {
    updated: result.updatedFiles.size > 0,
    updatedFiles: [...result.updatedFiles],
    missingIds: result.missingIds,
  };
}

async function readRequirementIdentity(rootDir) {
  const guide = await readFile(path.join(rootDir, '00-需求引导.md'), 'utf8');
  const heading = guide.match(/^#\s+(.+?)\s*$/mu)?.[1] ?? path.basename(rootDir);
  const name = heading.replace(/(?:总需求引导|需求审核指南|需求引导)$/u, '').trim();
  const stage = guide.match(/^>\s*阶段[：:]\s*(.+?)\s*$/mu)?.[1] ?? '未分期';
  return { name, stage };
}

export async function buildRequirementPackage(rootDir, index, sourceArtifacts) {
  const identity = await readRequirementIdentity(rootDir);
  const detailFiles = [...new Set(index.requirements.map((item) => item.file))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const requirementPackage = {
    schemaVersion: 1,
    generatedAt: index.generatedAt,
    requirement: {
      ...identity,
      reviewStatus: index.reviewPlan.completed ? 'completed' : 'reviewing',
    },
    documents: {
      guide: './00-需求引导.md',
      requirementIndex: './requirement-index.json',
      details: detailFiles.map((file) => `./${file}`),
    },
    reviewSummary: index.reviewSummary,
    uiHandoff: {
      strategy: 'source-fragment-to-compressed-cache',
      extractorScript: 'scripts/extract-ui-context.mjs',
      refetchWhen: ['cache-missing', 'integrity-failed', 'user-requested-latest'],
    },
    sourceArtifacts: sourceArtifacts.map((item) => ({
      id: item.sourceId,
      kind: item.kind,
      status: item.status,
      developmentReady: item.developmentReady,
      manifest: `./${item.manifest}`,
      index: item.indexFile,
      sourceMap: item.sourceMapFile,
      sourceUrl: item.sourceUrl,
      fileId: item.fileId,
      layerId: item.layerId,
      sourceLayerId: item.sourceLayerId,
      format: item.format,
      storage: item.storage ? { ...item.storage, archive: item.archiveFile } : null,
      expectedSections: item.expectedSections,
      fetchedSections: item.fetchedSections,
      totalBytes: item.totalBytes,
      archiveBytes: item.archiveBytes ?? null,
      mappedFragments: item.mappedFragments ?? 0,
    })),
  };
  await writeFile(path.join(rootDir, 'requirement-package.json'), `${JSON.stringify(requirementPackage, null, 2)}\n`, 'utf8');
  return requirementPackage;
}

export async function buildRequirementIndex(rootInput, options = {}) {
  const rootDir = path.resolve(rootInput);
  const requirements = await scanRequirements(rootDir);
  assertNoDuplicates(requirements, '需求');
  let linkResult = await refreshGuideLinks(rootDir, requirements, options);
  let reviewCompletion = null;
  if (options.completeReviewGroup) {
    reviewCompletion = await confirmResolvedReviewGroup(rootDir, options.completeReviewGroup, requirements);
    const completionRefresh = await refreshGuideLinks(rootDir, requirements, options);
    linkResult = {
      updated: linkResult.updated || completionRefresh.updated,
      updatedFiles: [...new Set([...linkResult.updatedFiles, ...completionRefresh.updatedFiles])],
      missingIds: [...new Set([...linkResult.missingIds, ...completionRefresh.missingIds])],
    };
  }
  const guidePoints = await scanGuidePoints(rootDir, requirements);
  const questions = await scanQuestions(rootDir);
  const sources = await scanSources(rootDir);
  assertNoDuplicates(sources, '来源片段');
  const reviewSummary = summarize(guidePoints, questions);
  const reviewPlan = buildReviewPlan(guidePoints, questions);
  const sourceArtifacts = await readUiCacheManifests(rootDir);
  const index = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root: rootDir,
    requirements: requirements.map(({ absoluteFile, anchorPresent, ...item }) => item),
    guidePoints,
    reviewSummary,
    reviewPlan,
    questions,
    sources: sources.map(({ absoluteFile, anchorPresent, ...item }) => item),
    sourceArtifacts,
    syncStatus: reviewSummary.staleGuidePoints > 0 ? 'possibly_stale' : 'synced',
  };
  await writeFile(path.join(rootDir, 'requirement-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  const requirementPackage = await buildRequirementPackage(rootDir, index, sourceArtifacts);
  return { index, linkResult, requirementPackage, reviewCompletion };
}

function cliOption(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const completeReviewGroup = cliOption(args, '--complete-review-group');
  const optionValues = new Set([completeReviewGroup].filter(Boolean));
  const rootDir = args.find((arg) => !arg.startsWith('--') && !optionValues.has(arg));
  const acceptGuideSync = args.includes('--accept-guide-sync');
  if (!rootDir) {
    process.stderr.write('用法: node build-requirement-index.mjs <需求包目录> [--accept-guide-sync] [--complete-review-group UC01]\n');
    process.exitCode = 2;
    return;
  }

  try {
    const { index, linkResult, requirementPackage, reviewCompletion } = await buildRequirementIndex(rootDir, {
      acceptGuideSync,
      completeReviewGroup,
    });
    process.stdout.write(`${JSON.stringify({
      indexed: index.requirements.length,
      guidePoints: index.reviewSummary.total,
      reviewedGuidePoints: index.reviewSummary.understood,
      needsChangeGuidePoints: index.reviewSummary.needsChange,
      blockingQuestions: index.reviewSummary.blockingQuestions,
      staleGuidePoints: index.reviewSummary.staleGuidePoints,
      nextReviewFile: index.reviewPlan.next?.file ?? null,
      nextReviewItems: index.reviewPlan.next?.focusItems.map((item) => item.id) ?? [],
      nextReviewFeatures: index.reviewPlan.next?.features.map((item) => ({ id: item.id, title: item.title, status: item.reviewStatus })) ?? [],
      nextReviewQuestions: index.reviewPlan.next?.pendingQuestions.map((item) => ({ id: item.id, title: item.title, impact: item.impact })) ?? [],
      nextReviewReadyToAutoConfirm: index.reviewPlan.next?.readyToAutoConfirm ?? false,
      guideUpdated: linkResult.updated,
      guideFilesUpdated: linkResult.updatedFiles,
      missingLinkIds: linkResult.missingIds,
      acceptedGuideSync: acceptGuideSync,
      completedReviewGroup: reviewCompletion,
      indexFile: path.join(path.resolve(rootDir), 'requirement-index.json'),
      packageFile: path.join(path.resolve(rootDir), 'requirement-package.json'),
      uiCaches: requirementPackage.sourceArtifacts.map((item) => ({ id: item.id, status: item.status })),
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
