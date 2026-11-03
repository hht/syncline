import type { Problem, SourceText } from './problem.ts';

const han = /\p{Script=Han}/u;

/** Rejects Han characters in every git-tracked text file. */
export function checkEnglish(files: SourceText[]): Problem[] {
  return files.flatMap(({ path, text }) => {
    if (text.includes('\0')) return [];
    return text
      .split('\n')
      .flatMap((line, index) =>
        han.test(line)
          ? [{ file: path, line: index + 1, rule: 'english', message: 'Han characters are not allowed; write in English' }]
          : [],
      );
  });
}
