import { expect, test } from 'vitest';
import { checkCommands, checkGateClaims, checkPackagePaths, checkPaths } from './docs.ts';

const messages = (problems: { line: number; message: string }[]) => problems.map((p) => `${p.line} ${p.message}`);

test('links and repo paths must exist', () => {
  const docs = [
    {
      path: 'AGENTS.md',
      text: `see [a](docs/a.md), [missing](docs/missing.md#section), [external](https://example.com)
paths \`docs/b.md\`, \`tools/x/y.ts\`
not repo paths: \`../other-repo\`, \`.check/<gate>.log\`, \`expo-router/entry\``,
    },
    { path: 'docs/adr/001.md', text: '[method](../PARITY.md), [missing](../NOPE.md)' },
  ];
  const existing = new Set(['docs/a.md', 'docs/b.md', 'docs/PARITY.md']);
  expect(checkPaths(docs, (path) => existing.has(path)).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'AGENTS.md:1 docs/missing.md does not exist',
    'AGENTS.md:2 tools/x/y.ts does not exist',
    'docs/adr/001.md:1 docs/NOPE.md does not exist',
  ]);
});

test('source paths in docs must exist: with directory against root or src/, bare filenames must match exactly one; other extensions ignored', () => {
  const files = [
    'src/cloud/reader.ts',
    'src/device/conflicts.test.ts',
    'model/Syncline.tla',
    'model/MC.cfg',
    'src/expo/worker.ts',
    'probes/worker.ts',
    'src/build-wasm.mjs',
  ];
  const docs = [
    {
      path: 'docs/internals/model.md',
      text: `\`cloud/reader.ts\`, \`src/cloud/reader.ts\`, \`model/Syncline.tla\`, \`MC.cfg\`, \`conflicts.test.ts\`
\`build-wasm.mjs\`, \`gone.mjs\`, \`cloud/gone.ts\`, \`missing.test.ts\`, \`worker.ts\`, \`expo/worker.ts\`, \`app.json\`, \`.check/model-cache.json\`, \`syncline/expo\``,
    },
  ];
  expect(checkPackagePaths(docs, files).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'docs/internals/model.md:2 gone.mjs does not exist',
    'docs/internals/model.md:2 cloud/gone.ts does not exist',
    'docs/internals/model.md:2 missing.test.ts does not exist',
    'docs/internals/model.md:2 worker.ts has 2 matches; use a path with its directory',
  ]);
});

test('Commands section and root scripts match bidirectionally', () => {
  const agents = `## Commands

- \`pnpm check\`: all gates
- \`pnpm check --changed\`: changed only
- \`pnpm dev\`: development

## Commits
`;
  expect(messages(checkCommands(agents, ['check', 'q']))).toEqual([
    '5 pnpm dev has no matching script',
    '1 script q is not listed in the Commands section',
  ]);
});

test('referenced gates must exist, free-form text is rejected', () => {
  const docs = [
    { path: 'AGENTS.md', text: 'Lower layers must not reference upper layers. — gate `depcruise`' },
    {
      path: 'docs/STANDARDS.md',
      text: `- No any. — gate \`tsc\` \`biome\`
- Coverage. — gate \`coverage\`
- Only transition can change state. — TODO: lint
- Module load must not initialize. — **gate: lint**`,
    },
  ];
  expect(checkGateClaims(docs, ['biome', 'tsc', 'depcruise', 'knip']).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'docs/STANDARDS.md:2 gate coverage does not exist; write "TODO: ..." for unimplemented gates',
    'docs/STANDARDS.md:4 write gate references as gate `<name>`, or "TODO: ..." for unimplemented gates',
  ]);
});

test('throws when required section is missing, preventing false passes', () => {
  expect(() => checkCommands('# Title\n\n## Other\n', [])).toThrow('missing section ## Commands');
});
