import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSnapshot, SnapshotAbort } from './snapshot.mjs';
import {
  CURATED_IDS, TURKEY_IDS, GROUP_PLAN, TURKEY_SOURCE_GROUP, MAX_INDIVIDUAL_PER_RUN,
  SOURCE_MIN_AGE_MS, INDIVIDUAL_MAX_AGE_MS,
} from './plan.mjs';

// ---- helpers: a fake CelesTrak (no network, per CelesTrak's usage policy) ----
const rec = (id, name = `SAT ${id}`, epoch = '2026-10-27T10:00:00.000000') => ({
  OBJECT_NAME: name, OBJECT_ID: '2000-001A', EPOCH: epoch, MEAN_MOTION: 14.5, ECCENTRICITY: 0.001,
  INCLINATION: 98.2, RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 10, EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: id, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1,
  BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
});

const MUST_HAVE = [...new Set([...CURATED_IDS, ...TURKEY_IDS])];
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-10-27T12:00:00Z');

function fakeCelesTrak({ groups = {}, catnr = {}, failOn = null, hang = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, { signal } = {}) => {
    const q = new URL(url).searchParams;
    const key = q.get('GROUP') ? `GROUP=${q.get('GROUP')}` : `CATNR=${q.get('CATNR')}`;
    calls.push(key);
    if (hang) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    if (key === failOn) return new Response('Forbidden', { status: 403 });
    if (q.get('GROUP')) return new Response(JSON.stringify(groups[q.get('GROUP')] ?? []), { status: 200 });
    const one = catnr[q.get('CATNR')];
    return new Response(one ? JSON.stringify([one]) : 'No GP data found', { status: 200 });
  };
  return { fetchImpl, calls };
}

// One record per group (ids 1000+i and 2000+i), plus `geo` with one wanted and one unwanted satellite.
const baseGroups = (epoch) => {
  const g = {};
  GROUP_PLAN.forEach(({ celestrak }, i) => { g[celestrak] = [rec(1000 + i, `SAT ${1000 + i}`, epoch), rec(2000 + i, `SAT ${2000 + i}`, epoch)]; });
  g[TURKEY_SOURCE_GROUP] = [rec(33056, 'TURKSAT 3A', epoch), rec(99999, 'SOME OTHER GEO SAT', epoch)];
  return g;
};
const catnrAll = (epoch) => Object.fromEntries(MUST_HAVE.map(id => [id, rec(id, `SAT ${id}`, epoch)]));

const clock = ms => () => ms;
const opts = extra => ({ sleep: async () => {}, minTotal: 1, log: () => {}, now: clock(T0), ...extra });
const catnrCalls = calls => calls.filter(c => c.startsWith('CATNR=')).length;

// A real cold-start snapshot taken at T0 — used as `previous` in the incremental tests.
async function coldStart(extra = {}) {
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups('2026-10-27T10:00:00.000000'), catnr: catnrAll('2026-10-27T10:00:00.000000') });
  return buildSnapshot(opts({ fetchImpl, ...extra }));
}

// ---- cold start ----
test('merges groups, dedupes a satellite shared by two groups, keeps both memberships', async () => {
  const groups = baseGroups();
  const shared = rec(40000, 'SHARED');
  groups.resource.push(shared); groups.sar.push(shared);
  const snap = await buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups }).fetchImpl }));
  assert.equal(snap.schema, 1);
  assert.equal(snap.sats.filter(s => s.NORAD_CAT_ID === 40000).length, 1);
  assert.ok(snap.groups.resource.includes(40000) && snap.groups.sar.includes(40000));
});

test('keeps 6-digit catalog numbers (objects that have no TLE)', async () => {
  const groups = baseGroups();
  groups.stations.push(rec(100057, 'SOYUZ-MS 29'));
  const snap = await buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups }).fetchImpl }));
  assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === 100057));
  assert.ok(snap.groups.stations.includes(100057));
});

test('Turkey group: only the wanted ids are picked out of geo, others are dropped', async () => {
  const snap = await buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups: baseGroups() }).fetchImpl }));
  assert.ok(snap.groups.turkey.includes(33056) && snap.geoIds.includes(33056));
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === 99999));
});

test('curated/Turkish ids no list covers are completed with one CATNR request each; unknown ids are skipped', async () => {
  const catnr = catnrAll();
  delete catnr[56178]; // CelesTrak has nothing for this one
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), catnr });
  const snap = await buildSnapshot(opts({ fetchImpl }));
  for (const id of CURATED_IDS) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing curated ${id}`);
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === 56178));
  assert.ok(catnrCalls(calls) > 0);
});

test('cold start aborts at the first non-200 and makes no further requests (CelesTrak usage policy)', async () => {
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), failOn: 'GROUP=weather' });
  await assert.rejects(buildSnapshot(opts({ fetchImpl })), SnapshotAbort); // required groups are still missing
  assert.equal(calls[calls.length - 1], 'GROUP=weather');
  assert.equal(calls.length, GROUP_PLAN.findIndex(g => g.celestrak === 'weather') + 1);
});

test('refuses to publish a suspiciously small snapshot or an empty required group', async () => {
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups() });
  await assert.rejects(buildSnapshot(opts({ fetchImpl, minTotal: 400 })), /refusing to publish/);
  const groups = baseGroups(); groups['gps-ops'] = [];
  await assert.rejects(buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups }).fetchImpl })), /required group "gps"/);
});

test('waits between requests', async () => {
  const sleeps = [];
  await buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ groups: baseGroups() }).fetchImpl, gapMs: 500, sleep: async ms => { sleeps.push(ms); } }));
  assert.ok(sleeps.length >= GROUP_PLAN.length && sleeps.every(ms => ms === 500));
});

test('a request that hangs is aborted by the per-request timeout; with nothing fetched the run fails safely', async () => {
  await assert.rejects(buildSnapshot(opts({ fetchImpl: fakeCelesTrak({ hang: true }).fetchImpl, requestTimeoutMs: 20 })), SnapshotAbort);
});

// ---- incremental behaviour ----
test('nothing is due right after a run: no requests, no new snapshot', async () => {
  const previous = await coldStart();
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups() });
  const result = await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + 30 * 60 * 1000) }));
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('two hours later every group is due again and gets refreshed; dataAt moves forward', async () => {
  const previous = await coldStart();
  const later = T0 + 2 * HOUR;
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups('2026-10-27T12:00:00.000000'), catnr: catnrAll('2026-10-27T12:00:00.000000') });
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(later) }));
  assert.equal(calls.filter(c => c.startsWith('GROUP=')).length, GROUP_PLAN.length + 1);
  assert.equal(Date.parse(snap.dataAt), later);
  assert.ok(Date.parse(previous.dataAt) < Date.parse(snap.dataAt));
});

test('when a request fails mid-run, the progress made so far is published and the rest is carried over', async () => {
  const previous = await coldStart();
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups('2026-10-27T12:00:00.000000'), failOn: 'GROUP=weather' });
  const later = T0 + 3 * HOUR;
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(later) }));
  assert.equal(calls[calls.length - 1], 'GROUP=weather', 'stops at the failure');
  // refreshed before the failure
  assert.equal(snap.sources['group:stations'], new Date(later).toISOString());
  // not refreshed: keeps the old timestamp and still has its old members
  assert.equal(snap.sources['group:weather'], previous.sources['group:weather']);
  assert.deepEqual(snap.groups.weather, previous.groups.weather);
  assert.ok(snap.groups.weather.every(id => snap.sats.some(s => s.NORAD_CAT_ID === id)));
});

test('sources are fetched oldest first, so a source that keeps getting cut off cannot starve', async () => {
  const previous = await coldStart();
  const old = new Date(T0 - 5 * HOUR).toISOString();
  previous.sources['group:science'] = old; // the stalest one
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups(), catnr: catnrAll() });
  await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + 3 * HOUR) }));
  assert.equal(calls[0], 'GROUP=science');
});

test('a run that runs out of time budget publishes what it got; the next run continues with the rest', async () => {
  const previous = await coldStart();
  const later = T0 + 3 * HOUR;
  let calls = 0, t = later;
  const inner = fakeCelesTrak({ groups: baseGroups('2026-10-27T13:00:00.000000'), catnr: catnrAll() }).fetchImpl;
  const fetchImpl = (u, o) => { calls++; return inner(u, o); };
  // every request "takes" 6 s of the 20 s budget -> only ~4 requests fit
  const ticking = () => { const v = t; t += 0; return v + calls * 6000; };
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: ticking, budgetMs: 20_000 }));
  const fresh = Object.entries(snap.sources).filter(([k, v]) => k.startsWith('group:') && v !== previous.sources[k]);
  assert.ok(fresh.length > 0 && fresh.length < GROUP_PLAN.length + 1, `partial progress expected, got ${fresh.length}`);
  // the next run (1 h later) finds the unfinished sources still due and starts with them
  const second = fakeCelesTrak({ groups: baseGroups('2026-10-27T14:00:00.000000'), catnr: catnrAll() });
  await buildSnapshot(opts({ fetchImpl: second.fetchImpl, previous: snap, now: clock(later + HOUR) }));
  const unfinished = GROUP_PLAN.map(g => `group:${g.celestrak}`).filter(k => snap.sources[k] === previous.sources[k]);
  assert.ok(unfinished.length > 0);
  assert.equal(second.calls[0], unfinished[0].replace('group:', 'GROUP='));
});

test('a satellite that left every list (and is not curated) is dropped; curated ones are kept', async () => {
  const previous = await coldStart();
  const groups = baseGroups('2026-10-27T12:00:00.000000');
  groups.resource = groups.resource.filter(r => r.NORAD_CAT_ID !== 1000 + GROUP_PLAN.findIndex(g => g.id === 'resource'));
  const { fetchImpl } = fakeCelesTrak({ groups, catnr: catnrAll() });
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + 3 * HOUR) }));
  const dropped = 1000 + GROUP_PLAN.findIndex(g => g.id === 'resource');
  assert.ok(!snap.sats.some(s => s.NORAD_CAT_ID === dropped));
  for (const id of CURATED_IDS) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `curated ${id} must stay`);
});

// ---- individually looked-up satellites ----
test('individual records refreshed recently are not requested again', async () => {
  const previous = await coldStart();
  // 3 h later groups are due but the individual lookups (6 h rule) are not
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups('2026-10-27T13:00:00.000000'), catnr: catnrAll() });
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + 3 * HOUR) }));
  assert.equal(catnrCalls(calls), 0);
  for (const id of MUST_HAVE) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing ${id}`);
});

test('stale individual records are refreshed at most MAX_INDIVIDUAL_PER_RUN per run; the rest stay', async () => {
  const previous = await coldStart();
  const { fetchImpl, calls } = fakeCelesTrak({ groups: baseGroups('2026-10-27T20:00:00.000000'), catnr: catnrAll('2026-10-27T20:00:00.000000') });
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + INDIVIDUAL_MAX_AGE_MS + HOUR) }));
  assert.equal(catnrCalls(calls), MAX_INDIVIDUAL_PER_RUN);
  for (const id of MUST_HAVE) assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id), `missing ${id}`);
});

test('a satellite whose individual lookup comes back empty keeps its previous record', async () => {
  const previous = await coldStart();
  const stale = Object.keys(previous.sources).filter(k => k.startsWith('catnr:'));
  assert.ok(stale.length > 0);
  const id = Number(stale[0].replace('catnr:', ''));
  const catnr = catnrAll('2026-10-27T20:00:00.000000'); delete catnr[id];
  const { fetchImpl } = fakeCelesTrak({ groups: baseGroups('2026-10-27T20:00:00.000000'), catnr });
  const snap = await buildSnapshot(opts({ fetchImpl, previous, now: clock(T0 + INDIVIDUAL_MAX_AGE_MS + HOUR) }));
  assert.ok(snap.sats.some(s => s.NORAD_CAT_ID === id));
});

// ---- drift guard ----
test('CURATED_IDS matches the satellites hard-coded in index.html (drift guard)', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const inHtml = [...html.matchAll(/noradId:\s*(\d+)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  assert.equal(CURATED_IDS.length, 53);
  assert.deepEqual([...CURATED_IDS].sort((a, b) => a - b), inHtml);
});

test('SOURCE_MIN_AGE_MS is a little under CelesTrak\'s 2 h update interval', () => {
  assert.ok(SOURCE_MIN_AGE_MS < 2 * HOUR && SOURCE_MIN_AGE_MS > HOUR);
});
