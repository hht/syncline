import { readFileSync } from 'node:fs';
import { checkCommitMessage } from './commit-message.ts';

const problems = checkCommitMessage(readFileSync(process.argv[2] ?? '', 'utf8'));
console.log(problems.length > 0 ? `✍️ commit-message ❌ ${problems.length} 处问题` : '✍️ commit-message ✅ 通过');
for (const problem of problems) console.log(`   提交说明 ${problem}`);
process.exitCode = problems.length > 0 ? 1 : 0;
