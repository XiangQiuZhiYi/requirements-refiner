#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CAPABILITIES = {
  yuqueOutline: {
    labels: ['yuque_get_doc_outline'],
    descriptionTerms: ['yuque', 'outline'],
  },
  yuqueBundle: {
    labels: ['yuque_export_docs_bundle'],
    descriptionTerms: ['yuque', 'bundle'],
  },
  yuqueMarkdown: {
    labels: ['yuque_get_doc_markdown_by_url', 'yuque_get_doc_markdown'],
    descriptionTerms: ['yuque', 'markdown'],
    optional: true,
  },
  mastergoSections: {
    labels: ['mastergo_getdesignsections', 'getdesignsections'],
    descriptionTerms: ['mastergo', 'section'],
  },
  mastergoDsl: {
    labels: ['mastergo_getdsl', 'getdsl'],
    descriptionTerms: ['mastergo', 'dsl'],
    optional: true,
  },
};

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function terminalName(name) {
  return String(name ?? '').split('__').filter(Boolean).at(-1) ?? '';
}

function scoreTool(tool, definition) {
  const name = normalize(tool.name);
  const terminal = normalize(terminalName(tool.name));
  const labels = definition.labels.map(normalize);
  if (labels.includes(terminal)) return 100;
  if (labels.some((label) => name.endsWith(label))) return 90;
  const description = normalize(tool.description);
  if (definition.descriptionTerms.every((term) => description.includes(normalize(term)))) return 40;
  return 0;
}

export function resolveMcpTools(tools, definitions = REQUIRED_CAPABILITIES) {
  const normalizedTools = (Array.isArray(tools) ? tools : []).filter((tool) => tool && typeof tool.name === 'string');
  const mapping = {};
  const missing = [];
  const ambiguous = [];

  for (const [capability, definition] of Object.entries(definitions)) {
    const matches = normalizedTools
      .map((tool) => ({ tool, score: scoreTool(tool, definition) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
    if (matches.length === 0) {
      if (!definition.optional) missing.push(capability);
      continue;
    }
    const best = matches.filter((item) => item.score === matches[0].score).map((item) => item.tool.name);
    if (best.length > 1) ambiguous.push({ capability, candidates: best });
    else mapping[capability] = best[0];
  }

  return { mapping, missing, ambiguous, valid: missing.length === 0 && ambiguous.length === 0 };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('用法: node resolve-mcp-tools.mjs <工具清单.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const parsed = JSON.parse(await readFile(path.resolve(input), 'utf8'));
    const tools = Array.isArray(parsed) ? parsed : parsed.tools;
    const result = resolveMcpTools(tools);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
