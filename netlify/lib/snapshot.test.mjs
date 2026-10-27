import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSnapshot, SnapshotAbort } from './snapshot.mjs';
import { CURATED_IDS, TURKEY_IDS, GROUP_PLAN, MAX_INDIVIDUAL_PER_RUN } from './plan.mjs';

// ---- helpers: a fake CelesTrak (no network, per CelesTrak's usage policy) ----
const rec = (id, name = `SAT ${id}`, epoch = '2026-10-27T10:00:00.000000') => ({
  OBJECT_NAME: name, OBJECT_ID: '2000-001A', EPOCH: epoch, MEAN_MOTION: 14.5, ECCENTRICITY: 0.001,
  INCLINATION: 98.2, RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 10, EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1,
  BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
});

function fakeCelesTrak({ groups = {}, catnr = {}, failOn = null } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const q = new URL(url).searchParams;
    const key = q.get('GROUP') ? `GROUP=${q.get('GROUP')}` : `CATNR=${q.get('CATNR')}`;
    calls.push(key);
    if (key === failOn) return new Response('Forbidden', { status: 403 });
    if (q.get('GROUP')) {
      const list = groups[q.get('GROUP')];
      return new Response(JSON.stringify(list ?? []), { status: 200 });
    }
    const one = catnr[q.get('CATNR')];
    return new Response(one ? JSON.stringify([one]) : 'No GP data found', { status: 200 });
  };
  return { fetchImpl, calls };
}

const baseGroups = () => {
  const g = {};
  GROUP_PLAN.forEach(({ celestrak }, i) => { g[celestrak] = [rec(1000 + i), rec(2000 + i)]; });
  g.geo = [rec(33056, 'TURKSAT 3A'), rec(99999, 'SOME OTHER GEO SAT')];
  return g;
};

const opts = extra => ({ sleep: async () => {}, minTotal: 1, log: () => {}, ...extra });

// ---- tests ----
test('merges groups, dedupes a satellite shared by two groups, keeps both memberships', async () => {
  const groups = baseGroups();
  const shared = rec(40000, 'SHARED');
  groups.resource.push(shared); groups.sar.push(shared);
  const { fetchImpl } = fakeCelesTrak({ groups });
  const snap = await buildSnapshot(opts({ fetchImpl }));
  assert.equal(snap.schema, 1);
  assert.equal(snap.sats.filter(s => s.NORAD_CAT_ID === 40000).length, 1);
  assert.ok(snap.groups.resource.includes(40000) && snap.groups.sar.includes(40000));
});

test('keeps 6-digit catalog numbers (objects that have no TLE)', async () => {
  const groups = baseGroups();
  groups.stations.push(rec(100057, 'SOYUZ-MS 29'));
  const { fetchImpl } = fakeCelesTrak({ groups });
  const snap = await buildSnapshot(opts({ fetchImpl }));
  assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === 100057));
  assert.ok(snap.groups.stations.includes(100057));
});

test('Turkey group: only the wanted ids are picked out of geo, others are dropped', async () => {
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups() });
  const snap = await buildSnapshot(opts({ fetchImpl }));
  assert.ok(snap.groups.turkey.includes(33056));
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === 99999));
});

test('curated/Turkish ids not covered by any group are completed with one CATNR request each; unknown ids are skipped', async () => {
  const catnr = {};
  for (const id of [...CURATED_IDS, ...TURKEY_IDS]) catnr[id] = rec(id);
  delete catnr[56178]; // CelesTrak has nothing for this one
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), catnr });
  const snap = await buildSnapshot(opts({ fetchImpl }));
  for (const id of CURATED_IDS) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing curated ${id}`);
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === 56178));
  assert.ok(calls.some(c => c.startsWith('CATNR=')));
});

test('aborts at the first non-200 and makes no further requests (CelesTrak usage policy)', async () => {
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), failOn: 'GROUP=weather' });
  await assert.rejects(buildSnapshot(opts({ fetchImpl })), SnapshotAbort);
  assert.equal(calls[calls.length - 1], 'GROUP=weather');
  assert.equal(calls.length, GROUP_PLAN.findIndex(g => g.celestrak === 'weather') + 1);
});

test('refuses to publish a suspiciously small snapshot or an empty required group', async () => {
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups() });
  await assert.rejects(buildSnapshot(opts({ fetchImpl, minTotal: 400 })), /refusing to publish/);
  const groups = baseGroups(); groups['gps-ops'] = [];
  await assert.rejects(buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups }).fetchImpl })), /required group "gps"/);
});

test('waits between requests and gives up when the time budget is exceeded', async () => {
  const sleeps = [];
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups() });
  await buildSnapshot(opts({ fetchImpl, gapMs: 500, sleep: async ms => { sleeps.push(ms); } }));
  assert.ok(sleeps.length >= GROUP_PLAN.length && sleeps.every(ms => ms === 500));

  let t = 0;
  await assert.rejects(
    buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups: baseGroups() }).fetchImpl, now: () => (t += 10_000), budgetMs: 25_000 })),
    /time budget/,
  );
});

test('CURATED_IDS matches the satellites hard-coded in index.html (drift guard)', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const inHtml = [...html.matchAll(/noradId:\s*(\d+)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  assert.equal(CURATED_IDS.length, 53);
  assert.deepEqual([...CURATED_IDS].sort((a, b) => a - b), inHtml);
});

test('if the time budget runs out during the individual lookups, it still publishes the group data', async () => {
  const groupCount = GROUP_PLAN.length + 1; // + geo
  let calls = 0;
  const catnr = {};
  for (const id of [...CURATED_IDS, ...TURKEY_IDS]) catnr[id] = rec(id);
  const { fetchImpl: inner } = fakeCelesTrak({ groups: baseGroups(), catnr });
  const fetchImpl = async url => { calls++; return inner(url); };
  // clock jumps past the budget once all group requests are done
  const now = () => (calls > groupCount ? 100_000 : 0);
  const snap = await buildSnapshot(opts({ fetchImpl, now, budgetMs: 25_000 }));
  assert.ok(snap.sats.length >= GROUP_PLAN.length * 2);
  // the first lookup happens before the clock jumps; everything after it is skipped
  assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === CURATED_IDS[0]));
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === CURATED_IDS[CURATED_IDS.length - 1]), 'later individual lookups should have been skipped');
});

// ---- carry-over / per-run cap / timeout ----
const MUST_HAVE = [...new Set([...CURATED_IDS, ...TURKEY_IDS])];
const catnrAll = () => { const c = {}; for (const id of MUST_HAVE) c[id] = rec(id, `SAT ${id}`, '2026-10-27T12:00:00.000000'); return c; };
const previousSnapshot = ageHours => {
  const at = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
  return {
    sats: MUST_HAVE.map(id => rec(id, `OLD ${id}`, '2026-10-26T00:00:00.000000')),
    refreshedAt: Object.fromEntries(MUST_HAVE.map(id => [id, at])),
  };
};
const catnrCalls = calls => calls.filter(c => c.startsWith('CATNR=')).length;

test('records refreshed recently are carried over from the previous snapshot — no CATNR requests', async () => {
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), catnr: catnrAll() });
  const snap = await buildSnapshot(opts({ fetchImpl, previous: previousSnapshot(1) }));
  assert.equal(catnrCalls(calls), 0);
  for (const id of MUST_HAVE) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing ${id}`);
  assert.ok(snap.refreshedAt[CURATED_IDS[0]], 'carried-over ids keep their refresh time');
});

test('stale records are refreshed at most MAX_INDIVIDUAL_PER_RUN per run; the rest are still carried over', async () => {
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), catnr: catnrAll() });
  const snap = await buildSnapshot(opts({ fetchImpl, previous: previousSnapshot(10) }));
  assert.equal(catnrCalls(calls), MAX_INDIVIDUAL_PER_RUN);
  for (const id of MUST_HAVE) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing ${id}`);
  const refreshedNow = snap.sats.filter(s => MUST_HAVE.includes(s.NORAD_CAT_ID) && s.OBJECT_NAME.startsWith('SAT '));
  assert.equal(refreshedNow.length, MAX_INDIVIDUAL_PER_RUN);
});

test('a satellite whose individual lookup comes back empty keeps its previous record instead of vanishing', async () => {
  const catnr = catnrAll();
  const previous = previousSnapshot(10);
  const oldest = MUST_HAVE[0];
  previous.refreshedAt[oldest] = new Date(Date.now() - 100 * 3600 * 1000).toISOString(); // refreshed first
  delete catnr[oldest];
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups(), catnr });
  const snap = await buildSnapshot(opts({ fetchImpl, previous }));
  assert.equal(snap.sats.find(s => s.NORAD_CAT_ID === oldest).OBJECT_NAME, `OLD ${oldest}`);
});

test('a request that hangs is aborted by the per-request timeout and the whole run fails safely', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(buildSnapshot(opts({ fetchImpl, requestTimeoutMs: 20 })), SnapshotAbort);
});
