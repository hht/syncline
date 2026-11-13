import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { noticeFor } from '../../src/cloud/broadcast.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Poke } from '../../src/protocol/messages.ts';
import { createProject, project, pullRest, viewer } from '../support/test-cabinet.ts';
import { Device } from '../support/test-device.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Shared test fixtures for shared spaces on device: shared space with project table (public bucket),
// device synced with private workbooks, pulling chunk by chunk until staging empty.

export const workbook = sqliteTable('workbook', { id: text().primaryKey(), project_id: text() });
export const createWorkbook = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, project_id TEXT)';
export const buckets = { public: { project: { where: "status = 'published'" } } };

/** Shared space (no chunk boundaries: incremental watermark is the cookie) and a device: workbooks in private space, projects in shared space. */
export function setup() {
  const space = new Space(cloudStorage(createProject), [project], { shared: { buckets } });
  const storage = deviceStorage(createWorkbook, createProject);
  const device = new Device(storage, [workbook]);
  const cabinet = device.shared('cabinet', [project]);
  /** Server mutates a project, returns broadcast shard notice forwarded to device (filtered to device subscription in this round). */
  const publish = (id: string, status = 'published') => {
    const base = space.head();
    space.mutate((tx) => tx.upsert(project, { id, status }), 0);
    return noticeFor(space.round(64_000, base), viewer) as Poke;
  };
  const projects = () => drizzle(storage).select().from(project).orderBy(project.id).all();
  /** Pulls until caught up: local projects match ids, no longer behind. */
  const caughtUp = async (ids: string[]) => {
    await pullRest(cabinet, space);
    expect(projects().map(({ id }) => id)).toEqual(ids);
    expect(cabinet.behind()).toBe(false);
  };
  return { space, storage, device, cabinet, publish, projects, caughtUp };
}
