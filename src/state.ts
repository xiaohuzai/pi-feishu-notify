/**
 * pi-feishu-notify — 状态存储原语
 *
 * 跨进程/跨 session 的状态文件（通知路由、会话注册、去重认领）的原子读写，
 * 带目录锁（mkdir 原子创建实现互斥）与崩溃残留容忍。
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** pi 状态根目录。默认 ~/.pi/agent，可用 PI_FEISHU_NOTIFY_STATE_DIR 覆盖（测试隔离 / 自定义路径）。 */
export function stateDir(): string {
  return process.env.PI_FEISHU_NOTIFY_STATE_DIR ?? join(homedir(), '.pi', 'agent');
}

/** 目录锁：mkdir 原子创建实现跨进程互斥。 */
export function withDirLock<T>(lockDir: string, fn: () => T): T | undefined {
  let acquired = false;
  for (let i = 0; i < 40; i++) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        try {
          if (Date.now() - statSync(lockDir).mtimeMs > 15000) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        } catch {
          // 忽略：竞争删除
        }
        const until = Date.now() + 75;
        while (Date.now() < until) {
          // 忙等 75ms（锁持有时间极短）
        }
        continue;
      }
      break;
    }
  }
  if (!acquired) return undefined;
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
}

/** 读改写一个 JSON 文件，带目录锁。 */
export function mutateJson<T>(
  file: string,
  lockDir: string,
  def: () => T,
  mutate: (st: T) => void,
  prune?: (st: T) => void,
): void {
  withDirLock(lockDir, () => {
    try {
      let st: T;
      try {
        st = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        st = def();
      }
      mutate(st);
      prune?.(st);
      mkdirSync(stateDir(), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(st, null, 2));
      renameSync(tmp, file);
    } catch {
      // 状态文件异常不阻断主流程
    }
  });
}

export function readJson<T>(file: string, def: () => T): T {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed ?? def();
  } catch {
    return def();
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
