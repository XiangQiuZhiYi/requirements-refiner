#!/usr/bin/env node

import { InstallerError, runCli } from '../lib/installer.mjs';

try {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
} catch (error) {
  const payload = {
    ok: false,
    code: error instanceof InstallerError ? error.code : 'UNEXPECTED_ERROR',
    error: error instanceof Error ? error.message : String(error),
  };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`安装器错误 [${payload.code}]：${payload.error}\n`);
  process.exitCode = 1;
}
