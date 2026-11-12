import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

test('both installed SDKs resolve their own pinned native CLI, without a shared bin shim', () => {
  const dirs = [];
  for (const [name, version] of [['@anthropic-ai/claude-agent-sdk', '0.3.280'], ['claude-agent-sdk-next', '0.3.322']]) {
    const entry = import.meta.resolve(name);
    const dir = path.dirname(fileURLToPath(entry));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    assert.equal(pkg.version, version);
    assert.equal(pkg.bin, undefined);
    for (const nativeVersion of Object.values(pkg.optionalDependencies)) assert.equal(nativeVersion, version);
    const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : '';
    const native = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl}`;
    const req = createRequire(entry);
    const bin = req.resolve(`${native}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(bin), 'package.json'))).version, version);
    assert.match(execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true }), new RegExp(pkg.claudeCodeVersion.replaceAll('.', '\\.')));
    dirs.push(bin);
  }
  assert.notEqual(dirs[0], dirs[1]);
});
