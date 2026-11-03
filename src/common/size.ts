import type { Op } from './protocol.ts';

// 量一份东西有多大：平台的上限是字节的（WebSocket 一条消息、DO 存的单个值与一行）按 UTF-8 字节量，JS 里的文字经这里的 utf8Bytes、fitsBytes，
// 库里的值用 SQL 的 octet_length；编码后只剩 ASCII 的（URL 里的参数）字符数就是字节数。Syncline 自己定的预算（拉取的一块、校验和的一段、
// 广播一次通知在分片里复制的总量）按字符数量，省掉逐条编码，改动的 JSON 经 opChars。按字符切又要守字节上限的，字符数取字节上限的 1/4

const encoder = new TextEncoder();

export const utf8Bytes = (text: string) => encoder.encode(text).length;

/** 文字编成 UTF-8 在 limit 字节之内：字符数不超过 UTF-8 字节数，先比字符数，超了就不用再编码 */
export const fitsBytes = (text: string, limit: number) => text.length <= limit && utf8Bytes(text) <= limit;

export const opChars = (op: Op) => JSON.stringify(op).length;
