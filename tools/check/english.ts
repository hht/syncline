import type { Problem, SourceText } from './problem.ts';

const han = /\p{Script=Han}/u;

/** Chinese translations of the integrator documents, which mirror their English sources. */
const translated = (path: string) => path === 'README.zh-CN.md' || /^docs\/(reference|guides)\/zh-CN\//.test(path);

/** The language switcher linking an English document to its translation, such as `English | [Simplified Chinese](README.zh-CN.md)` in Chinese. */
const switcher = /\[\u7b80\u4f53\u4e2d\u6587\]\([^)\s]*zh-CN[^)\s]*\)/gu;

/** Rejects Han characters in every git-tracked text file, except Chinese translations and the switcher linking to them. */
export function checkEnglish(files: SourceText[]): Problem[] {
  return files.flatMap(({ path, text }) => {
    if (text.includes('\0') || translated(path)) return [];
    return text
      .split('\n')
      .flatMap((line, index) =>
        han.test(line.replace(switcher, ''))
          ? [{ file: path, line: index + 1, rule: 'english', message: 'Han characters are not allowed; write in English' }]
          : [],
      );
  });
}
