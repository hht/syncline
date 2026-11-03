import { readFileSync } from 'node:fs';
import { checkCommitMessage } from './commit-message.ts';

const problems = checkCommitMessage(readFileSync(process.argv[2] ?? '', 'utf8'));
console.log(problems.length > 0 ? `✍️ commit-message ❌ ${problems.length} problem(s)` : '✍️ commit-message ✅ passed');
for (const problem of problems) console.log(`   commit message: ${problem}`);
process.exitCode = problems.length > 0 ? 1 : 0;
