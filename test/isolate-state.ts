import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 给当前测试文件分配一个独立的 state 目录，并通过
 * PI_FEISHU_NOTIFY_STATE_DIR 让 src/state.ts 的 stateDir() 指向它。
 *
 * 背景：各测试文件在 vitest 并行 worker 里独立运行，若不隔离，它们会共用
 * 真实的 ~/.pi/agent，导致状态文件（discovered/sessions/router/dedup）互相
 * 污染与竞争——CI 上曾偶发 discovery 测试读到被别的文件删掉的状态而失败。
 *
 * 每个 worker 是独立进程，env 互不影响，因此每个测试文件都能拿到自己的目录。
 */
export function isolateStateDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-fn-${label}-`));
  process.env.PI_FEISHU_NOTIFY_STATE_DIR = dir;
  return dir;
}
