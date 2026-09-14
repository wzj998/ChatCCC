import { spawn, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCursorAdapter } from '../adapters/cursor-adapter.ts';
import { killProcessTree } from '../adapters/proc-tree-kill.ts';

describe('adapter process tree integration', () => {
  it('releases a descendant-held port before the stopped prompt returns', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/cli-process-tree.mjs', import.meta.url));
    let rootPid: number | undefined;
    let childPid: number | undefined;
    let port = 0;
    const adapter = createCursorAdapter({
      metaStore: { get: async () => undefined, set: async () => {} },
      spawn: ((_command: string, _args: string[], options: SpawnOptions) => {
        // Retain the adapter's actual shell, stdio and detached settings.
        const child = spawn(`"${process.execPath}"`, [`"${fixture}"`], options);
        rootPid = child.pid;
        return child;
      }) as unknown as typeof spawn,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      for await (const message of adapter.prompt('integration-stop-tree', 'test', process.cwd(), controller.signal)) {
        const block = message.blocks.find(b => b.type === 'text' || b.type === 'text_final');
        if (block && 'text' in block) {
          const info = JSON.parse(block.text);
          childPid = info.pid; port = info.port;
          controller.abort();
        }
      }
      expect(port).toBeGreaterThan(0);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    } finally {
      clearTimeout(timeout);
      await killProcessTree(rootPid);
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }, 20_000);
});
