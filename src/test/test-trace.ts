import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '../common/storage.ts';
import { head } from './test-commits.ts';
import type { Device } from './test-device.ts';

// 轨迹核对：模拟每走一步，记下这一步里实现做了哪些在模型里有对应动作的事（网络上的在
// 替身网络发生处记，写、崩溃、部署、恢复这些在模拟里记），与走完之后看得见的状态（各台设备的游标版本、待上传几条，云端最新一版）；
// 写成 TLA+ 模块交给 model/TracePrivate.tla。TLC 找一条模型的执行：每一步把记下的动作按任意次序各做一次（标了可以没有的可以不做），
// 走完与看见的状态一致。找不到就是实现做了模型不允许的事（或这里的对应写错了）。
// 只核对控制流：写的内容不比（实现的写是整行的值，模型的写是加一与删除），数据对不对由模拟按模型的性质直接查。
// @see https://arxiv.org/abs/2406.17455

/**
 * 一条消息是哪条（TracePrivate.tla 的 Is）：t 是模型里的消息种类（push、pullreq、poke、hint、pullresp、chunk、reset），
 * b 是它接在哪一版上（拉取是请求带的游标，没有是 -1），c 是通知与末块给到的那一版，n 是推送的写有几条；-2 是没记。
 * 共用空间的块与末块另带 s（算它时的最新一版）与 sub（按的订阅）
 */
export type Message = { t: string; b?: number; c?: number; n?: number; s?: number; sub?: string };

/**
 * 模型里的一个动作：a 是动作名，d 是第几台设备（从 1 起，与设备无关的是 0），k 是时间点恢复到的版本，optional 是模型里可以没有它，
 * 收发、丢掉的另带是哪条消息
 */
type Act = { a: string; d: number; k: number; optional: boolean } & Required<Omit<Message, 's' | 'sub'>>;

type Line = { step: string; acts: Act[]; cookie: number[]; pending: number[]; staged: number[]; head: number };

/** 一块的 next 里尾巴追到的那一版（模型里位置的 p） */
function tailOf(next: string) {
  const position = parse(next) as { tail?: { at?: { version: number } } } | undefined;
  return position?.tail?.at?.version;
}

/** 设备暂存到了哪：最后一块的 next 里尾巴追到的那一版，没有暂存是 -1 */
function stagedAt(storage: Storage) {
  const [row] = storage.sql.exec("SELECT next FROM _syncline_stage WHERE space = '' ORDER BY seq DESC LIMIT 1").toArray();
  if (!row) return -1;
  return tailOf(String(row.next)) ?? -2;
}

/** 设备收到的一条 WebSocket 消息是哪条：通知（补齐也是）或提示 */
export function socketMessage(text: string): Message {
  const value = parse(text) as { hint?: { version: number }; base?: { version: number } | null; cookie?: { version: number } } | undefined;
  if (!value) return { t: 'hint' };
  if (value.hint) return { t: 'hint', c: value.hint.version };
  return { t: 'poke', b: value.base?.version ?? -1, c: value.cookie?.version ?? -2 };
}

/** 设备推上去的一批写 */
export function pushMessage(text: string): Message {
  const value = parse(text);
  return { t: 'push', n: Array.isArray(value) ? value.length : -2 };
}

/** HTTP 拉取的应答是哪条：末块、中间块或 reset；回错的在模型里没有（请求丢了） */
export function pullMessage(status: number, text: string): Message | undefined {
  const value = parse(text) as
    | { reset?: boolean; base?: { version: number } | null; cookie?: { version: number }; next?: string; seen?: number; sub?: string }
    | undefined;
  if (status !== 200 || !value) return undefined;
  const b = value.base?.version ?? -1;
  // 共用空间的块与末块带 seen（算它时的最新一版）与按的订阅
  const s = value.seen ?? -2;
  const sub = value.sub === undefined ? {} : { sub: value.sub };
  if (value.reset) return { t: 'reset', b };
  if (value.cookie) return { t: 'pullresp', b, c: value.cookie.version, s, ...sub };
  // 中间块：尾巴追到的那一版是模型里块的位置的 p。切在一次提交中间（带 index）的，模型里是给完了那之前的提交、这一次的还没给
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

  /** 这一步做的是什么（只为看轨迹时认得出） */
  step(step: string) {
    this.#step = this.#step ? `${this.#step}+${step}` : step;
  }

  /** 这一步里实现做了一件模型里有对应动作的事；index 是第几台设备（从 0 起），与设备无关的不给 */
  add(a: string, index?: number, { optional = false, k = 0, message }: { optional?: boolean; k?: number; message?: Message } = {}) {
    const { t = '', b = -2, c = -2, n = -2 } = message ?? {};
    // 共用空间的轨迹另记 s；私有空间不用
    this.#acts.push({ a, d: index === undefined ? 0 : index + 1, k, optional, t, b, c, n });
  }

  /** 这一步走完了：记下看得见的状态（storages 是各台设备的库） */
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

  /** 写成 dir/TraceLog.tla */
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
