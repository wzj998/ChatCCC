// Run after npm run build, under Linux/macOS Node. No Agent or credentials used.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { cliProcessOptions, ownCliProcess, ensureCliSessionReleased } from '../dist/src/adapters/managed-cli-process.js';

assert.notEqual(process.platform, 'win32');
const fixture = fileURLToPath(new URL('../src/__tests__/fixtures/cli-process-tree.mjs', import.meta.url));
for (let run = 0; run < 3; run++) {
  await ensureCliSessionReleased('posix-test');
  const root = spawn(`"${process.execPath}"`, [`"${fixture}"`], {
    shell: true, stdio: ['ignore', 'pipe', 'inherit'], ...cliProcessOptions(),
  });
  const owner = ownCliProcess('posix-test', root.pid);
  let descendant;
  const timeout = setTimeout(() => { void owner.stop().catch(() => {}); }, 10_000);
  try {
    for await (const line of createInterface({ input: root.stdout })) {
      descendant = JSON.parse(JSON.parse(line).message.content[0].text);
      break;
    }
    assert.ok(descendant?.port > 0);
    await Promise.all([owner.stop(), owner.stop()]);
    await ensureCliSessionReleased('posix-test');
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(descendant.port, '127.0.0.1', () => probe.close(resolve));
    });
    console.log(`PASS ${run + 1}: descendant port released; same session reusable`);
  } finally {
    clearTimeout(timeout);
    await owner.stop();
    if (descendant?.pid) { try { process.kill(descendant.pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
}
