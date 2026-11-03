import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '../common/storage.ts';
import { head } from './test-commits.ts';
import type { Device } from './test-device.ts';

// Trace validation: at every simulation step, records implementation actions that correspond to model actions
// in model/TracePrivate.tla, along with post-step observable state (device cookies, pending counts, cloud head).
// Checks control flow against TLA+ protocol model.
// @see https://arxiv.org/abs/2406.17455

/**
 * Message descriptor (Is in TracePrivate.tla): t is model message type (push, pullreq, poke, hint, pullresp, chunk, reset);
 * b is base version; c is cookie version; n is push mutation count; -2 is unrecorded.
 * Shared space chunks additionally track seen version s and subscription sub.
 */
export type Message = { t: string; b?: number; c?: number; n?: number; s?: number; sub?: string };

/**
 * Model action: a is action name, d is 1-based device index (0 for global), k is restore target version,
 * optional indicates skippable action in model.
 */
type Act = { a: string; d: number; k: number; optional: boolean } & Required<Omit<Message, 's' | 'sub'>>;

type Line = { step: string; acts: Act[]; cookie: number[]; pending: number[]; staged: number[]; head: number };

/** Tail target version recorded in chunk next token (position p in model). */
function tailOf(next: string) {
  const position = parse(next) as { tail?: { at?: { version: number } } } | undefined;
  return position?.tail?.at?.version;
}

/** Latest tail target version among staged chunks for device (-1 if un-staged). */
function stagedAt(storage: Storage) {
  const [row] = storage.sql.exec("SELECT next FROM _syncline_stage WHERE space = '' ORDER BY seq DESC LIMIT 1").toArray();
  if (!row) return -1;
  return tailOf(String(row.next)) ?? -2;
}

/** Resolves incoming WebSocket message descriptor: poke (or catch-up) or hint. */
export function socketMessage(text: string): Message {
  const value = parse(text) as { hint?: { version: number }; base?: { version: number } | null; cookie?: { version: number } } | undefined;
  if (!value) return { t: 'hint' };
  if (value.hint) return { t: 'hint', c: value.hint.version };
  return { t: 'poke', b: value.base?.version ?? -1, c: value.cookie?.version ?? -2 };
}

/** Resolves pushed mutation batch descriptor. */
export function pushMessage(text: string): Message {
  const value = parse(text);
  return { t: 'push', n: Array.isArray(value) ? value.length : -2 };
}

/** Resolves HTTP pull response descriptor: pullresp, chunk, or reset (undefined for HTTP errors). */
export function pullMessage(status: number, text: string): Message | undefined {
  const value = parse(text) as
    | { reset?: boolean; base?: { version: number } | null; cookie?: { version: number }; next?: string; seen?: number; sub?: string }
    | undefined;
  if (status !== 200 || !value) return undefined;
  const b = value.base?.version ?? -1;
  // Shared space chunks carry seen version and subscription.
  const s = value.seen ?? -2;
  const sub = value.sub === undefined ? {} : { sub: value.sub };
  if (value.reset) return { t: 'reset', b };
  if (value.cookie) return { t: 'pullresp', b, c: value.cookie.version, s, ...sub };
  // Intermediate chunk: tail target version corresponds to chunk position p in model.
  const at = tailOf(value.next ?? '');
  return { t: 'chunk', b, s, ...sub, ...(at === undefined ? {} : { c: at }) };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class Tracer {
  readonly #lines: Line[] = [];
  #acts: Act[] = [];
  #step = '';

  /** Sets description for current step (for diagnostic trace readability). */
  step(step: string) {
    this.#step = this.#step ? `${this.#step}+${step}` : step;
  }

  /** Records model action for step: index is 0-based device index (omitted for global actions). */
  add(a: string, index?: number, { optional = false, k = 0, message }: { optional?: boolean; k?: number; message?: Message } = {}) {
    const { t = '', b = -2, c = -2, n = -2 } = message ?? {};
    // Shared space trace validation records s; private space does not.
    this.#acts.push({ a, d: index === undefined ? 0 : index + 1, k, optional, t, b, c, n });
  }

  /** Post-step observation: records observable state across devices and cloud head. */
  observe(devices: Device[], storages: Storage[], cloud: Storage) {
    this.#lines.push({
      step: this.#step || 'flush',
      acts: this.#acts,
      cookie: devices.map((device) => device.private.cookie()?.version ?? -1),
      pending: devices.map((device) => device.private.pendingCount()),
      staged: storages.map(stagedAt),
      head: head(cloud).version,
    });
    this.#acts = [];
    this.#step = '';
  }

  /** Writes trace to dir/TraceLog.tla. */
  write(dir: string) {
    mkdirSync(dir, { recursive: true });
    const record = ({ step, acts, cookie, pending, staged, head: version }: Line) => {
      const list = acts.map(
        ({ a, d, k, optional, t, b, c, n }) =>
          `[a |-> "${a}", d |-> ${d}, k |-> ${k}, o |-> ${optional ? 'TRUE' : 'FALSE'}, t |-> "${t}", b |-> ${b}, c |-> ${c}, n |-> ${n}]`,
      );
      const name = step.replace(/[^\w+.#]/g, '').slice(0, 60);
      return `  [step |-> "${name}", acts |-> <<${list.join(', ')}>>, cookie |-> <<${cookie.join(', ')}>>, pending |-> <<${pending.join(', ')}>>, staged |-> <<${staged.join(', ')}>>, head |-> ${version}]`;
    };
    const module = [
      '---- MODULE TraceLog ----',
      'EXTENDS Integers, Sequences',
      'TraceLog == <<',
      this.#lines.map(record).join(',\n'),
      '>>',
      '====',
    ];
    writeFileSync(join(dir, 'TraceLog.tla'), `${module.join('\n')}\n`);
  }
}
