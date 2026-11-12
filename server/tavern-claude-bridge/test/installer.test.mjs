import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(new URL('../../../install.ps1', import.meta.url), 'utf8');
const step = source.slice(source.indexOf('# --- Step 5:'), source.indexOf('# --- Step 6:'));

for (const scenario of ['complete', 'missing-next', 'wrong-next', 'npm-failed']) {
  test(`installer validates both pinned SDKs and npm exit status: ${scenario}`, { skip: process.platform !== 'win32' }, () => {
    const target = fs.mkdtempSync(path.join(root, 'node_modules/.installer-test-'));
    for (const [name, version] of [['@anthropic-ai/claude-agent-sdk', '0.3.280'], ['claude-agent-sdk-next', scenario === 'wrong-next' ? '0.3.280' : '0.3.322']]) {
      if (name === 'claude-agent-sdk-next' && scenario === 'missing-next') continue;
      const dir = path.join(target, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
    }
    // Execute the real installer step; replace only npm so tests never install into a user's tavern.
    const script = `$targetDir = $env:TCB_INSTALLER_TEST_TARGET
function Write-Step { }
function Write-OK { }
function Write-Err { }
function Write-Warn { }
function npm { $global:LASTEXITCODE = ${scenario === 'npm-failed' ? 7 : 0} }
${step}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, TCB_INSTALLER_TEST_TARGET: target }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, scenario === 'complete' ? 0 : 1, result.stdout + result.stderr);
  });
}
