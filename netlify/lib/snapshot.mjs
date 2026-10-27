import {
  CELESTRAK_GP_URL, USER_AGENT, GROUP_PLAN, TURKEY_SOURCE_GROUP, TURKEY_IDS, CURATED_IDS,
  MIN_TOTAL_SATS, REQUIRED_GROUPS, REQUEST_GAP_MS, TIME_BUDGET_MS, REQUEST_TIMEOUT_MS,
  SOURCE_MIN_AGE_MS, INDIVIDUAL_MAX_AGE_MS, MAX_INDIVIDUAL_PER_RUN,
} from './plan.mjs';

// Thrown when a CelesTrak request fails (non-200, timeout, unparseable body). CelesTrak's policy:
// on the first failure stop querying and don't retry — whatever was fetched before is still kept.
export class SnapshotAbort extends Error {}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Builds the next snapshot from CelesTrak GP data (OMM/JSON — never TLE: objects numbered 100000+
 * have no TLE), incrementally.
 *
 * Every CelesTrak request is a "source" (a group, the `geo` group, or a single satellite by NORAD
 * id) with its own last-fetched time, kept in `previous.sources`. A run only fetches the sources
 * that are due (older than SOURCE_MIN_AGE_MS, i.e. CelesTrak has published an update since), oldest
 * first, one request at a time, until it runs out of time budget or a request fails. Everything it
 * did not refresh is carried over from `previous`. So a slow or flaky CelesTrak only delays some
 * sources until a later run; it can't starve them or cost the whole snapshot.
 *
 * Returns the new snapshot, or null when nothing was due. Throws SnapshotAbort when nothing could
 * be refreshed or the result would be too poor to publish.
 *
 * @param {object} [opts] everything is injectable so tests never touch the network
 */
export async function buildSnapshot(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = sleepMs,
    now = Date.now,
    gapMs = REQUEST_GAP_MS,
    budgetMs = TIME_BUDGET_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    previous = null,
    minTotal = MIN_TOTAL_SATS,
    requiredGroups = REQUIRED_GROUPS,
    log = () => {},
  } = opts;

  const startedAt = now();
  let requests = 0;

  async function get(query) {
    if (requests > 0) await sleep(gapMs);
    requests++;
    const url = `${CELESTRAK_GP_URL}?${query}&FORMAT=json`;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      throw new SnapshotAbort(`request failed or timed out for ${query}: ${err.name || err.message}`);
    }
    if (res.status !== 200) throw new SnapshotAbort(`HTTP ${res.status} for ${query}`);
    return res.text();
  }

  async function fetchGroup(name) {
    const text = await get(`GROUP=${encodeURIComponent(name)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new SnapshotAbort(`non-JSON body for group ${name}`); }
    if (!Array.isArray(data)) throw new SnapshotAbort(`unexpected body for group ${name}`);
    return data;
  }

  // A single object by NORAD id. CelesTrak answers 200 with a plain-text message when it has
  // nothing for that id; that just means "skip it", unlike a malformed group response.
  async function fetchCatnr(id) {
    const text = await get(`CATNR=${id}`);
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) && data.length ? data[0] : null;
    } catch { return null; }
  }

  // ---- start from the previous snapshot; fresh data overwrites it source by source ----
  const sats = new Map(((previous && previous.sats) || []).map(r => [Number(r.NORAD_CAT_ID), r]));
  const groups = {};
  for (const { id } of GROUP_PLAN) groups[id] = [...((previous && previous.groups && previous.groups[id]) || [])];
  let geoIds = [...((previous && previous.geoIds) || [])];
  const sources = { ...((previous && previous.sources) || {}) };
  const ageOf = key => (sources[key] ? now() - Date.parse(sources[key]) : Infinity);
  const stamp = () => new Date(now()).toISOString();

  function add(record) {
    const id = Number(record.NORAD_CAT_ID);
    if (!Number.isFinite(id)) return null;
    const prev = sats.get(id);
    if (!prev || String(record.EPOCH) >= String(prev.EPOCH)) sats.set(id, record);
    return id;
  }

  let fetched = 0;
  let stoppedBy = null;
  const overBudget = () => now() - startedAt > budgetMs;

  // Runs one fetch; returns false (and records why) when the run should stop.
  async function step(work) {
    if (overBudget()) { stoppedBy = 'time budget reached'; return false; }
    try { await work(); fetched++; return true; } catch (err) {
      if (!(err instanceof SnapshotAbort)) throw err;
      stoppedBy = err.message;
      return false;
    }
  }

  // ---- 1. groups (+ geo), oldest first ----
  const groupSources = [
    ...GROUP_PLAN.map(g => ({ key: `group:${g.celestrak}`, kind: 'group', id: g.id, celestrak: g.celestrak })),
    { key: `group:${TURKEY_SOURCE_GROUP}`, kind: 'geo', celestrak: TURKEY_SOURCE_GROUP },
  ];
  const dueGroups = groupSources.filter(s => ageOf(s.key) >= SOURCE_MIN_AGE_MS).sort((a, b) => ageOf(b.key) - ageOf(a.key));
  const wanted = new Set(TURKEY_IDS);

  for (const s of dueGroups) {
    const ok = await step(async () => {
      const records = await fetchGroup(s.celestrak);
      if (s.kind === 'group') {
        groups[s.id] = [...new Set(records.map(add).filter(id => id !== null))].sort((a, b) => a - b);
        log(`group ${s.id}: ${groups[s.id].length}`);
      } else {
        geoIds = [];
        for (const record of records) if (wanted.has(Number(record.NORAD_CAT_ID))) { add(record); geoIds.push(Number(record.NORAD_CAT_ID)); }
        log(`geo: ${geoIds.length} wanted satellites`);
      }
      sources[s.key] = stamp();
    });
    if (!ok) break;
  }

  // ---- 2. individual lookups for must-have satellites no group/geo list covers ----
  if (!stoppedBy) {
    const covered = new Set([...Object.values(groups).flat(), ...geoIds]);
    const uncovered = [...new Set([...CURATED_IDS, ...TURKEY_IDS])].filter(id => !covered.has(id));
    const key = id => `catnr:${id}`;
    const neverSeen = uncovered.filter(id => !sats.has(id));
    const stale = uncovered.filter(id => sats.has(id) && ageOf(key(id)) >= INDIVIDUAL_MAX_AGE_MS)
      .sort((a, b) => ageOf(key(b)) - ageOf(key(a)));
    for (const id of [...neverSeen, ...stale.slice(0, MAX_INDIVIDUAL_PER_RUN)]) {
      const ok = await step(async () => {
        const record = await fetchCatnr(id);
        if (record) { add(record); sources[key(id)] = stamp(); } else log(`no GP data for ${id}`);
      });
      if (!ok) break;
    }
  }

  log(`fetched ${fetched} source(s)${stoppedBy ? `; stopped early: ${stoppedBy}` : ''}`);
  if (fetched === 0) {
    if (stoppedBy) throw new SnapshotAbort(stoppedBy);
    log('nothing due; snapshot unchanged');
    return null;
  }

  // ---- assemble: keep only satellites that are still in some list or that we must have ----
  const keep = new Set([...Object.values(groups).flat(), ...geoIds, ...CURATED_IDS, ...TURKEY_IDS]);
  groups.turkey = TURKEY_IDS.filter(id => sats.has(id)).sort((a, b) => a - b);
  const satList = [...sats.values()]
    .filter(r => keep.has(Number(r.NORAD_CAT_ID)))
    .sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID));
  if (satList.length < minTotal) {
    throw new SnapshotAbort(`only ${satList.length} satellites (< ${minTotal}); refusing to publish`);
  }
  for (const g of requiredGroups) {
    if (!groups[g] || groups[g].length === 0) throw new SnapshotAbort(`required group "${g}" is empty; refusing to publish`);
  }

  // dataAt = the oldest group refresh: how old the stalest part of this snapshot really is.
  const groupTimes = GROUP_PLAN.map(g => sources[`group:${g.celestrak}`]).filter(Boolean).map(Date.parse);
  return {
    schema: 1,
    generatedAt: stamp(),
    dataAt: groupTimes.length ? new Date(Math.min(...groupTimes)).toISOString() : stamp(),
    source: 'celestrak.org GP (JSON/OMM)',
    groups,
    geoIds,
    sources,
    sats: satList,
  };
}
