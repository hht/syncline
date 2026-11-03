import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Event } from '../cloud/events.ts';
import type { Quota } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import type { Mutation } from '../common/protocol.ts';
import type { SyncStatus } from '../expo/status.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { serving } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// 同步状态与手动同步的测试共用的：两张表的云端与一台还没同步过的设备

export const note = sqliteTable('note', { id: text().primaryKey() });
export const draft = sqliteTable('draft', { id: text().primaryKey() });
export const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';
export const createDraft = 'CREATE TABLE draft (id TEXT PRIMARY KEY)';
export const url = 'https://sync.test/space';
/** 一块约 6 条：8 条笔记分两块拉；一条通知（补齐、确认一条写）放得下 */
export const chunkLimit = 250;
export const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];

export const idle: SyncStatus = {
  connected: false,
  connecting: false,
  downloading: false,
  downloadProgress: undefined,
  pending: 0,
  hasSynced: false,
  downloadError: undefined,
  uploadError: undefined,
  updateNeeded: false,
};

/** 连着，状态里另要对上 also；不给 also 时要对上的是没有下载出错，给了就只对 also */
export const expectConnected = (connection: Connection, also: object = { downloadError: undefined }) =>
  expect(connection.status()).toMatchObject({ connected: true, ...also });

/** 设备发出的推送（待上传的数组）先经 tamper 改坏再上路：在线上造设备的缺陷，不碰设备内部 */
function tampering(socket: WebSocket, tamper: () => ((mutation: Mutation) => Mutation) | undefined) {
  const send = socket.send.bind(socket);
  socket.send = (data: string) => {
    const change = tamper();
    send(change && data.startsWith('[') ? JSON.stringify((JSON.parse(data) as Mutation[]).map(change)) : data);
  };
  return socket;
}

/**
 * 云端有 8 条笔记，一台还没同步过的设备；草稿表 draft 两边都同步，云端的校验不收它的行，写它的推送执行不了。
 * token 由 tokenFails 决定给不给，设备发出的推送经 tamper 改坏（给了时）；网络的动作由 run 一步步做完，云端处理推送抛的错收进 serverErrors。
 * quota：云端的写入额度，不给就不限
 */
export function setup(quota?: Quota) {
  const cloud = cloudStorage(createNote, createDraft);
  const refuse = { '~standard': { version: 1 as const, vendor: 'test', validate: () => ({ issues: [{ message: '云端不收草稿' }] }) } };
  const space = new Space(cloud, [note, draft], { validation: new Map([[draft, refuse]]) });
  space.mutate((tx) => {
    for (const id of ids) tx.insert(note, { id });
  });
  const events: Event[] = [];
  const { network, server } = serving(space, chunkLimit, (event) => events.push(event), { quota });
  const storage = deviceStorage(createNote, createDraft);
  const device = new Device(storage, [note, draft]);
  const state: { tokenFails: boolean; tamper?: (mutation: Mutation) => Mutation } = { tokenFails: false };
  const options = network.options(0);
  const connection = new Connection(device.private, {
    url,
    ...options,
    socket: (address, protocols) => tampering(options.socket(address, protocols), () => state.tamper),
    token: () => (state.tokenFails ? Promise.reject(new Error('取不到 token')) : Promise.resolve('valid')),
  });
  const seen: SyncStatus[] = [];
  connection.onStatus((status) => seen.push(status));
  const serverErrors: unknown[] = [];
  /** 做完网络上的事；advance 为假时不让时间往前走，看出错当下的状态 */
  const run = (advance = true) => drain(network, { steps: 100, advance, onError: (error) => serverErrors.push(error) });
  const notes = () => drizzle(storage).select().from(note).orderBy(note.id).all();
  return { cloud, space, server, network, storage, device, state, connection, seen, serverErrors, run, notes, events };
}
