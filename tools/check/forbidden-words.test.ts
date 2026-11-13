import { expect, test } from 'vitest';
import { checkForbiddenWords } from './forbidden-words.ts';

const rules = (path: string, text: string) => checkForbiddenWords([{ path, text }]).map((p) => `${p.line} ${p.message}`);

test('rejects declared names containing forbidden words', () => {
  expect(
    rules(
      'a.ts',
      `class WorkbookManager {}
const userData = 1;
function handleTap() {}
export const doSave = () => {};`,
    ),
  ).toEqual([
    '1 WorkbookManager contains forbidden word Manager; use a word that states what it does',
    '2 userData contains forbidden word Data; use a word that states what it does',
    '3 handleTap contains forbidden word handle; use a word that states what it does',
    '4 doSave contains forbidden word do; use a word that states what it does',
  ]);
});

test('allows framework patterns, third-party imports, and similar words', () => {
  expect(
    rules(
      'a.tsx',
      `import { processColor } from 'react-native';
function useWorkbook() { return processColor('red'); }
const AuthProvider = () => null;
const doneAt = 1;
const data = 2;`,
    ),
  ).toEqual([]);
});

test('allows externally mandated names (third-party globals) while rejecting own names', () => {
  expect(rules('a.ts', 'const handler = ErrorUtils.reportError;\nconst paymentInfo = 1;')).toEqual([
    '2 paymentInfo contains forbidden word Info; use a word that states what it does',
  ]);
});

test('rejects lowercase forbidden words', () => {
  expect(rules('a.ts', 'const utils = {};')).toEqual(['1 utils contains forbidden word Utils; use a word that states what it does']);
});

test('rejects filenames containing forbidden words', () => {
  expect(rules('src/date-utils.ts', '')).toEqual(['1 date-utils.ts contains forbidden word Utils; use a word that states what it does']);
  expect(rules('src/workbook-helper.web.ts', '')).toEqual([
    '1 workbook-helper.web.ts contains forbidden word Helper; use a word that states what it does',
  ]);
});

test('product names, comments, and strings do not mention integrator projects; whole words only, tools/ skipped', () => {
  const text = `// following neo style\nconst NeoSet = fc.oneof(a, b);\nconst label = 'Boostcamp';`;
  const message = 'do not mention integrator projects: Syncline is standalone; write general rules and examples';
  expect(rules('src/a.ts', text)).toEqual([`1 ${message}`, `2 ${message}`, `3 ${message}`]);
  expect(rules('tools/check/a.ts', text)).toEqual([]);
});

test('rejects words indicating provenance or ambiguous actions (old, temp, migrate, apply, split); allows sync, hold, template', () => {
  const text = `const oldConfig = 1;
const tempDir = 2;
function migrateUser() {}
function applyPatch() {}
const splitUser = 3;
const syncState = 4;
const legacyItems = 5;
const holdTime = 6;
const template = 7;`;
  expect(rules('a.ts', text)).toEqual([
    '1 oldConfig contains forbidden word Old; use a word that states what it does',
    '2 tempDir contains forbidden word Temp; use a word that states what it does',
    '3 migrateUser contains forbidden word Migrate; use a word that states what it does',
    '4 applyPatch contains forbidden word Apply; use a word that states what it does',
    '5 splitUser contains forbidden word Split; use a word that states what it does',
    '7 legacyItems contains forbidden word Legacy; use a word that states what it does',
  ]);
});

test('rejects page as ambiguous (screen, chunk, batch); allows pageant and similar words', () => {
  const text = `const lastPage = 1;
function readPages() {}
const pagedItems = 2;
const paging = 3;
const pageant = 4;`;
  expect(rules('a.ts', text)).toEqual([
    '1 lastPage contains forbidden word Page; use a word that states what it does',
    '2 readPages contains forbidden word Pages; use a word that states what it does',
    '3 pagedItems contains forbidden word Paged; use a word that states what it does',
    '4 paging contains forbidden word Paging; use a word that states what it does',
  ]);
});

test('rejects log as ambiguous; allows dialog, login', () => {
  const text = `const log = 1;
const changeLogs = 2;
const logger = 3;
const dialog = 4;
const login = 5;`;
  expect(rules('a.ts', text)).toEqual([
    '1 log contains forbidden word Log; use a word that states what it does',
    '2 changeLogs contains forbidden word Logs; use a word that states what it does',
    '3 logger contains forbidden word Logger; use a word that states what it does',
  ]);
});

test('rejects version numbers in names; p95 is not a version', () => {
  expect(rules('a.ts', 'const finishedV2At = 1;\nconst draft_v2 = 2;\nconst p95 = 3;')).toEqual([
    '1 finishedV2At contains version V2; name by meaning',
    '2 draft_v2 contains version v2; name by meaning',
  ]);
});

test('checks directory names as identifiers', () => {
  expect(rules('src/features/legacy/index.ts', '')).toEqual([
    '1 directory src/features/legacy contains forbidden word Legacy; use a word that states what it does',
  ]);
});

test('config files do not mention integrator projects; identifiers are not checked', () => {
  const message = 'do not mention integrator projects: Syncline is standalone; write general rules and examples';
  expect(rules('src/cloudflare/wrangler.jsonc', '{\n  "name": "neo-sync",\n  "legacy": true\n}')).toEqual([`2 ${message}`]);
});

test('checks Rust names converted to camelCase while reporting original names; checks enum variants, fields, parameters', () => {
  expect(
    rules(
      'rust/core/src/upload_helper.rs',
      `const SHRINK_PAGES: u32 = 1;
struct ColumnInfo { row_data: u8 }
enum Message { TempHeld }
fn handle_poke(user_data: u8) { let do_it = 1; }`,
    ),
  ).toEqual([
    '1 upload_helper.rs contains forbidden word Helper; use a word that states what it does',
    '1 SHRINK_PAGES contains forbidden word Pages; use a word that states what it does',
    '2 ColumnInfo contains forbidden word Info; use a word that states what it does',
    '2 row_data contains forbidden word Data; use a word that states what it does',
    '3 TempHeld contains forbidden word Temp; use a word that states what it does',
    '4 handle_poke contains forbidden word handle; use a word that states what it does',
    '4 user_data contains forbidden word Data; use a word that states what it does',
    '4 do_it contains forbidden word do; use a word that states what it does',
  ]);
});
