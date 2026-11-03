const subject = /^(feat|fix|change|refactor|test|docs|deps|chore): \S/;
const han = /\p{Script=Han}/u;
const scissors = '# ------------------------ >8 ------------------------';

/** Returns why the message is rejected; git's `#` hint lines are not part of the message. */
export function checkCommitMessage(message: string): string[] {
  // `git commit -v` appends the diff below the scissors line; it is not part of the message
  const [body = ''] = message.split(scissors);
  const lines = body.split('\n').filter((line) => !line.startsWith('#'));
  const [first = '', second] = lines;
  return [
    ...(subject.test(first) ? [] : ['first line must be <type>: <summary>, type is one of feat fix change refactor test docs deps chore']),
    ...(first.endsWith('.') ? ['summary must not end with a period'] : []),
    ...(lines.some((line) => han.test(line)) ? ['message must be in English'] : []),
    ...(second ? ['first line must be followed by a blank line'] : []),
  ];
}
