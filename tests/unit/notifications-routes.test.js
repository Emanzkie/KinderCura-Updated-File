// Unit tests for routes/notifications.js ownership and targeting.
//
// The reported defect: dismissing one notification removed a different one.
// DELETE /:id and PUT /:id/read built their filter as
// { ...buildNotificationQuery(id), ...buildUserQuery(userId) } — two `$or`
// keys in one object literal, so the id half was silently dropped and the
// request hit whichever of the user's notifications Mongo found first.
//
// No DB and no network: the Notification model and the raw collection are
// replaced by one in-memory store. Filters still go through Mongoose's own
// casting (with strictQuery on, as db.js sets it) before they are matched, so
// a filter that Mongoose would rewrite is tested the way it really runs.
const assert = require('assert');
const mongoose = require('mongoose');
const sift = require('sift').default || require('sift');

mongoose.set('strictQuery', true);

const Notification = require('../../models/Notification');
const router = require('../../routes/notifications');

const results = [];
const ok = (label) => results.push(label);
const oid = () => new mongoose.Types.ObjectId();

const realFind = Notification.find;
const castFilter = (filter) => {
  const q = realFind.call(Notification, filter);
  q.cast(Notification);
  return q.getFilter();
};

let store = [];
const matcher = (filter, cast = true) => sift(cast ? castFilter(filter) : filter);
const applySet = (doc, update) => Object.assign(doc, (update && update.$set) || {});
const lean = (v) => ({ lean: async () => v, sort: () => lean(v) });

Notification.find = (filter) => lean(store.filter(matcher(filter)));
Notification.countDocuments = async (filter) => store.filter(matcher(filter)).length;
Notification.updateMany = async (filter, update) => {
  const hits = store.filter(matcher(filter));
  hits.forEach((d) => applySet(d, update));
  return { modifiedCount: hits.length };
};
Notification.deleteMany = async (filter) => {
  const m = matcher(filter);
  const before = store.length;
  store = store.filter((d) => !m(d));
  return { deletedCount: before - store.length };
};
Notification.findOneAndUpdate = (filter, update) => {
  const hit = store.find(matcher(filter)) || null;
  if (hit) applySet(hit, update);
  return lean(hit);
};
Notification.findOneAndDelete = (filter) => {
  const hit = store.find(matcher(filter)) || null;
  if (hit) store = store.filter((d) => d !== hit);
  return lean(hit);
};

// The route also writes through the raw collection; it must obey the same filter.
const fakeCollection = {
  find: (filter) => ({ sort: () => ({ toArray: async () => store.filter(matcher(filter, false)) }) }),
  countDocuments: async (filter) => store.filter(matcher(filter, false)).length,
  updateMany: async (filter, update) => {
    const hits = store.filter(matcher(filter, false));
    hits.forEach((d) => applySet(d, update));
    return { modifiedCount: hits.length };
  },
  deleteMany: async (filter) => {
    const m = matcher(filter, false);
    const before = store.length;
    store = store.filter((d) => !m(d));
    return { deletedCount: before - store.length };
  },
  updateOne: async (filter, update) => {
    const hit = store.find(matcher(filter, false));
    if (hit) applySet(hit, update);
  },
  deleteOne: async (filter) => {
    const hit = store.find(matcher(filter, false));
    if (hit) store = store.filter((d) => d !== hit);
  },
};
mongoose.connection.collection = () => fakeCollection;

// Quiet the route's per-request debug logging while the tests run.
const quiet = (fn) => async (...args) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(...args); } finally { console.log = log; }
};

function handler(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert(layer, `route ${method.toUpperCase()} ${path} exists`);
  const stack = layer.route.stack;
  return quiet(stack[stack.length - 1].handle);
}

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const userA = oid();
const userB = oid();
let seq = 0;
const mk = (userId, title, isRead = false) => ({
  _id: oid(), id: ++seq, userId, title, message: `${title} message`, type: 'system', isRead,
  createdAt: new Date(Date.now() - seq * 60000),
});

function seed() {
  seq = 0;
  store = [
    mk(userA, 'A1 oldest'),
    mk(userA, 'A2'),
    mk(userA, 'A3 selected'),
    mk(userB, 'B1'),
    mk(userB, 'B2'),
  ];
}
const titles = (userId) => store.filter((d) => String(d.userId) === String(userId)).map((d) => d.title).sort();
const reqFor = (userId, params = {}) => ({ user: { userId: String(userId), role: 'parent' }, params });

async function deleteOneTests() {
  seed();
  const del = handler('delete', '/:id');
  const target = store.find((d) => d.title === 'A3 selected');
  const res = fakeRes();
  await del(reqFor(userA, { id: String(target.id) }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(titles(userA), ['A1 oldest', 'A2'], 'only the selected notification is removed');
  assert.deepStrictEqual(titles(userB), ['B1', 'B2']);
  ok('DELETE /:id removes exactly the selected notification, not the first one found');

  const foreign = store.find((d) => d.title === 'B1');
  await del(reqFor(userA, { id: String(foreign.id) }), fakeRes());
  assert.deepStrictEqual(titles(userB), ['B1', 'B2'], "another user's notification is untouched");
  assert.deepStrictEqual(titles(userA), ['A1 oldest', 'A2'], "and the caller's own list is not used as a fallback");
  ok("DELETE /:id with another user's id deletes nothing");

  const byObjectId = store.find((d) => d.title === 'A2');
  await del(reqFor(userA, { id: String(byObjectId._id) }), fakeRes());
  assert.deepStrictEqual(titles(userA), ['A1 oldest']);
  ok('DELETE /:id still accepts the Mongo _id form');
}

async function readOneTests() {
  seed();
  const read = handler('put', '/:id/read');
  const target = store.find((d) => d.title === 'A3 selected');
  await read(reqFor(userA, { id: String(target.id) }), fakeRes());
  const readTitles = store.filter((d) => d.isRead).map((d) => d.title);
  assert.deepStrictEqual(readTitles, ['A3 selected'], 'only the selected notification is marked read');
  ok('PUT /:id/read marks exactly the selected notification');

  const foreign = store.find((d) => d.title === 'B2');
  await read(reqFor(userA, { id: String(foreign.id) }), fakeRes());
  assert.strictEqual(foreign.isRead, false);
  assert.deepStrictEqual(store.filter((d) => d.isRead).map((d) => d.title), ['A3 selected']);
  ok("PUT /:id/read cannot touch another user's notification");
}

async function bulkTests() {
  seed();
  const readAll = handler('put', '/read-all');
  await readAll(reqFor(userA), fakeRes());
  assert(store.filter((d) => String(d.userId) === String(userA)).every((d) => d.isRead));
  assert(store.filter((d) => String(d.userId) === String(userB)).every((d) => !d.isRead));
  ok("PUT /read-all marks only the caller's notifications");

  const count = handler('get', '/count');
  const resB = fakeRes();
  await count(reqFor(userB), resB);
  assert.strictEqual(resB.body.unread, 2);
  const resA = fakeRes();
  await count(reqFor(userA), resA);
  assert.strictEqual(resA.body.unread, 0);
  ok('GET /count reports per-user unread totals');

  for (const path of ['/clear-all', '/all']) {
    seed();
    const clear = handler('delete', path);
    const res = fakeRes();
    await clear(reqFor(userA), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(titles(userA), []);
    assert.deepStrictEqual(titles(userB), ['B1', 'B2'], `${path} leaves other users alone`);
  }
  ok("DELETE /clear-all and /all remove only the caller's notifications");

  seed();
  const list = handler('get', '/');
  const res = fakeRes();
  await list(reqFor(userB), res);
  assert.deepStrictEqual(res.body.notifications.map((n) => n.title).sort(), ['B1', 'B2']);
  ok('GET / lists only the caller\'s notifications');
}

(async () => {
  await deleteOneTests();
  await readOneTests();
  await bulkTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Notification route tests OK — ${results.length} groups`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
