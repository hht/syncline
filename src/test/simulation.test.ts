import { test } from 'vitest';
import { seeds, seedTimeout, simulate } from './test-simulation.ts';

// 确定性模拟，不开云端时间点恢复的种子

test.for(seeds(false))(
  '种子 %i：断线、身份失效与续约、退到后台、设备崩溃、部署与协议回滚、表进入与离开同步、改坏的正文、对象存储出错、备份恢复与服务端写下至多一次、视图正确，故障停止后收敛，校验和对得上（不误报）',
  seedTimeout,
  simulate,
);
