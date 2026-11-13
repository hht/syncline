import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { cabinet, contents, doc, landedRequest, project, pullAll, rules, viewer } from '../support/test-cabinet.ts';

// Shared space pulls across bucket rule deployments: a changed rule drops and rescans only its table, a respelled rule changes nothing,
// and a rule changed and rolled back while a device is offline still converges to a fresh full pull.

test('deployment updates bucket rules on a table: incremental pull resumes without reset, dropping only updated table and rescanning under new rules; whitespace/case differences ignored', () => {
  const { cloud, space, publish } = cabinet();
  publish('p1');
  publish('p2', 'draft');
  publish('p3');
  const last = pullAll(space, viewer, { cookie: null });
  const respelled = new Space(cloud, [project, doc], {
    shared: { buckets: { ...rules, public: { ...rules.public, project: { where: "STATUS   =  'published'" } } }, chunkRows: 3 },
  });
  expect(respelled.head()).toEqual(space.head());
  const changed = new Space(cloud, [project, doc], {
    shared: {
      buckets: { ...rules, public: { ...rules.public, project: { where: "status IN ('published', 'draft') AND id <> 'p1'" } } },
      chunkRows: 3,
    },
  });
  const pulled = pullAll(changed, viewer, landedRequest(last));
  expect(pulled.some((chunk) => 'reset' in chunk)).toBe(false);
  expect(pulled.flatMap((chunk) => ('patch' in chunk ? chunk.patch : []))).toEqual([
    { op: 'drop', table: 'project' },
    { op: 'put', table: 'project', key: { id: 'p2' }, row: { id: 'p2', status: 'draft' } },
    { op: 'put', table: 'project', key: { id: 'p3' }, row: { id: 'p3', status: 'published' } },
  ]);
});

test('deployment updates bucket rules and deletes row now hidden under new rules: incremental pull removes row via table drop rather than subscription filter', () => {
  const { cloud, space, publish } = cabinet();
  publish('p1');
  publish('p2');
  const before = pullAll(space, viewer, { cookie: null });
  const changed = new Space(cloud, [project, doc], {
    shared: { buckets: { ...rules, public: { ...rules.public, project: { where: "status = 'published' AND id <> 'p1'" } } }, chunkRows: 3 },
  });
  changed.mutate((tx) => tx.delete(project, { id: 'p1' }));
  const after = pullAll(changed, viewer, landedRequest(before));
  expect(contents(before)).toEqual(['doc/p1-d', 'doc/p2-d', 'project/p1', 'project/p2']);
  // Doc references project, deleted via cascade
  expect(contents([...before, ...after])).toEqual(['doc/p2-d', 'project/p2']);
});

test('bucket rules updated and rolled back while offline: device resuming from earliest cookie matches fresh full pull exactly without missing or extraneous rows', () => {
  const { cloud, space, publish } = cabinet();
  publish('p1');
  publish('p2', 'draft');
  const before = pullAll(space, viewer, { cookie: null });
  const hidden = { ...rules, public: { ...rules.public, project: { where: "status = 'draft'" } } };
  const changed = new Space(cloud, [project, doc], { shared: { buckets: hidden, chunkRows: 3 } });
  changed.mutate((tx) => {
    tx.insert(project, { id: 'p3', status: 'published' });
    tx.update(project, { id: 'p1', status: 'draft' });
  });
  const back = new Space(cloud, [project, doc], { shared: { buckets: rules, chunkRows: 3 } });
  const after = pullAll(back, viewer, landedRequest(before));
  expect(after.some((chunk) => 'reset' in chunk)).toBe(false);
  expect(contents([...before, ...after])).toEqual(contents(pullAll(back, viewer, { cookie: null })));
});
