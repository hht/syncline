import { test } from 'vitest';
import { seeds, seedTimeout, simulate } from './test-simulation.ts';

// 确定性模拟，开着云端时间点恢复（可以不止一次）的种子

test.for(seeds(true))(
  '种子 %i：在不开恢复的那些故障之上，云端时间点恢复（可以不止一次）：回滚掉、没有设备还留着的写不复活，丢掉的只有回滚掉的，故障停止后收敛，校验和对得上（不误报）',
  seedTimeout,
  simulate,
);
