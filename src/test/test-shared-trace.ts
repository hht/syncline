import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './test-trace.ts';

// 共用空间的轨迹核对（交给 model/TraceShared.tla）：模型 Shared.tla 只有一台设备，所以每台设备各一条轨迹，
// 云端的后台写与部署记进每一条。每一步记下设备在模型里对应的动作（后台写、部署改了规则、令牌换了、连上时的补齐、分片推来的、收到连接上的消息、
// 发拉取、拉取回来（缓存里的是哪一版算的、按的哪份订阅）、拉取失败、断开与换连接、重启），与走完之后看得见的状态（游标版本、暂存了几块、
// 落地的订阅、令牌给的订阅、云端最新一版）

/** 模型里的一个动作：消息另带种类与版本，后台写另带改到的行 k 与它的分桶列 c（删掉是 0），令牌换了与拉取回来另带订阅 u（几个桶） */
type Act = { a: string; optional: boolean; t: string; b: number; c: number; k: string; u: string[] };

/** 一台设备看得见的状态：游标版本（没有是 -1）、暂存了几块、落地的订阅与令牌给的订阅（几个桶） */
export type Seen = { cookie: number; staged: number; landed: string[]; sub: string[] };

type Line = Seen & { step: string; acts: Act[]; head: number };

/** 云端新记的一版：后台写改到的一行 k 与它现在的分桶列 c（删掉是 0），或部署改了规则（没有 k） */
export type Version = { k?: string; c: number };

const act = (a: string, optional = false): Act => ({ a, optional, t: '', b: -2, c: -2, k: '', u: [] });

export class SharedTracer {
  /** 每台设备的各步 */
  readonly #lines: Line[][];
  #acts: Act[][];
  /** 每台设备第一次启动时令牌给的订阅（模型的 Sub0） */
  readonly #initial: string[][] = [];
  #step = '';
  /** 记到了云端的哪一版 */
  #head = 0;

  constructor(devices: number) {
    this.#lines = Array.from({ length: devices }, () => []);
    this.#acts = this.#lines.map(() => []);
  }

  step(step: string) {
    this.#step = this.#step ? `${this.#step}+${step}` : step;
  }

  /** 第 index 台设备第一次启动，令牌给的订阅是 sub */
  begin(index: number, sub: string[]) {
    this.#initial[index] = sub;
  }

  /** 第 index 台设备的一个动作；消息的种类照模型：通知是 notice，提示是 hint；拉取回来记的是算它时的那一版（seen） */
  add(index: number, a: string, { optional = false, message, sub = [] }: { optional?: boolean; message?: Message; sub?: string[] } = {}) {
    const t = message?.t === 'poke' ? 'notice' : (message?.t ?? '');
    const c = a === 'PullDone' ? (message?.s ?? -2) : (message?.c ?? -2);
    this.#acts[index]?.push({ ...act(a, optional), t, b: message?.b ?? -2, c, u: sub });
  }

  /** 这一步走完：云端新记的各版记进每台设备的轨迹，再记下各台设备看得见的状态与云端最新一版 */
  observe(versions: Version[], seen: Seen[], head: number) {
    for (const { k, c } of versions)
      for (const acts of this.#acts) acts.push(k === undefined ? act('RuleChange') : { ...act('Write'), k, c });
    this.#head = head;
    const step = this.#step || 'flush';
    for (const [index, state] of seen.entries()) this.#lines[index]?.push({ step, acts: this.#acts[index] ?? [], ...state, head });
    this.#acts = this.#lines.map(() => []);
    this.#step = '';
  }

  /** 上次记到的那一版：之后的各版下一步记成后台写或部署 */
  get head() {
    return this.#head;
  }

  /** 每台设备的轨迹写成 dir/shared-种子-第几台/TraceLog.tla */
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
