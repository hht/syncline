import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './test-trace.ts';

// Shared space trace validation (model/TraceShared.tla): model/Shared.tla models a single device, so each device maintains its own trace;
// cloud backend writes and deployments are duplicated into each trace.
// Records corresponding model actions per step (BackendWrite, RuleChange, SubChange, Connect, Push, Deliver, PullStart, PullDone, PullLost, Disconnect, Crash)
// alongside visible state post-step (cookie, staged chunk count, landed subscription, token subscription, cloud head).

/** Model action: message carries type and version; write carries touched key k and bucket column c; SubChange/PullDone carry subscription u. */
type Act = { a: string; optional: boolean; t: string; b: number; c: number; k: string; u: string[] };

/** Observable device state: cookie version (-1 if unset), staged chunk count, landed and token subscriptions. */
export type Seen = { cookie: number; staged: number; landed: string[]; sub: string[] };

type Line = Seen & { step: string; acts: Act[]; head: number };

/** Cloud version entry: touched row k and bucket column c (0 for delete), or rule evolution (undefined k). */
export type Version = { k?: string; c: number };

const act = (a: string, optional = false): Act => ({ a, optional, t: '', b: -2, c: -2, k: '', u: [] });

export class SharedTracer {
  /** Traced lines per device. */
  readonly #lines: Line[][];
  #acts: Act[][];
  /** Initial subscription assigned to device at launch (Sub0 in model). */
  readonly #initial: string[][] = [];
  #step = '';
  /** Cloud head version tracked through previous observation. */
  #head = 0;

  constructor(devices: number) {
    this.#lines = Array.from({ length: devices }, () => []);
    this.#acts = this.#lines.map(() => []);
  }

  step(step: string) {
    this.#step = this.#step ? `${this.#step}+${step}` : step;
  }

  /** Initial launch for device index with initial subscription sub. */
  begin(index: number, sub: string[]) {
    this.#initial[index] = sub;
  }

  /** Adds model action for device index; notice for poke, hint for hint; PullDone tracks seen version. */
  add(index: number, a: string, { optional = false, message, sub = [] }: { optional?: boolean; message?: Message; sub?: string[] } = {}) {
    const t = message?.t === 'poke' ? 'notice' : (message?.t ?? '');
    const c = a === 'PullDone' ? (message?.s ?? -2) : (message?.c ?? -2);
    this.#acts[index]?.push({ ...act(a, optional), t, b: message?.b ?? -2, c, u: sub });
  }

  /** Post-step observation: records newly emitted versions across all traces, snapshots device states and cloud head. */
  observe(versions: Version[], seen: Seen[], head: number) {
    for (const { k, c } of versions)
      for (const acts of this.#acts) acts.push(k === undefined ? act('RuleChange') : { ...act('Write'), k, c });
    this.#head = head;
    const step = this.#step || 'flush';
    for (const [index, state] of seen.entries()) this.#lines[index]?.push({ step, acts: this.#acts[index] ?? [], ...state, head });
    this.#acts = this.#lines.map(() => []);
    this.#step = '';
  }

  /** Cloud head tracked at prior check; subsequent versions recorded as writes or rule changes. */
  get head() {
    return this.#head;
  }

  /** Writes traces to TraceLog.tla files under dir/shared-seed-device/TraceLog.tla. */
  write(dir: string, seed: number) {
    const set = (items: string[]) => `{${items.map((item) => `"${item}"`).join(', ')}}`;
    const record = ({ step, acts, cookie, staged, landed, sub, head }: Line) => {
      const list = acts.map(
        ({ a, optional, t, b, c, k, u }) =>
          `[a |-> "${a}", o |-> ${optional ? 'TRUE' : 'FALSE'}, t |-> "${t}", b |-> ${b}, c |-> ${c}, k |-> "${k}", u |-> ${set(u)}]`,
      );
      const name = step.replace(/[^\w+.#]/g, '').slice(0, 60);
      return `  [step |-> "${name}", acts |-> <<${list.join(', ')}>>, cookie |-> ${cookie}, staged |-> ${staged}, landed |-> ${set(landed)}, sub |-> ${set(sub)}, head |-> ${head}]`;
    };
    for (const [index, lines] of this.#lines.entries()) {
      const target = join(dir, `shared-${seed}-${index + 1}`);
      mkdirSync(target, { recursive: true });
      const module = [
        '---- MODULE TraceLog ----',
        'EXTENDS Integers, Sequences',
        `TraceSub0 == ${set(this.#initial[index] ?? [])}`,
        'TraceLog == <<',
        lines.map(record).join(',\n'),
        '>>',
        '====',
      ];
      writeFileSync(join(target, 'TraceLog.tla'), `${module.join('\n')}\n`);
    }
  }
}
