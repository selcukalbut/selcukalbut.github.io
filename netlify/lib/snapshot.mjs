import {
  CELESTRAK_GP_URL, USER_AGENT, GROUP_PLAN, TURKEY_SOURCE_GROUP, TURKEY_IDS, CURATED_IDS,
  MIN_TOTAL_SATS, REQUIRED_GROUPS, REQUEST_GAP_MS, TIME_BUDGET_MS,
} from './plan.mjs';

// Thrown for anything that must stop the whole run (non-200, unparseable body, time budget...).
// CelesTrak's policy: on the first non-200, stop and don't retry — the caller keeps the old snapshot.
export class SnapshotAbort extends Error {}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Builds one snapshot from CelesTrak GP data (OMM/JSON — never TLE: objects numbered 100000+
 * have no TLE). Requests are sequential and spaced out; any non-200 aborts the run.
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
    minTotal = MIN_TOTAL_SATS,
    requiredGroups = REQUIRED_GROUPS,
    log = () => {},
  } = opts;

  const startedAt = now();
  let requests = 0;

  async function get(query) {
    if (now() - startedAt > budgetMs) throw new SnapshotAbort('time budget exceeded');
    if (requests > 0) await sleep(gapMs);
    requests++;
    const url = `${CELESTRAK_GP_URL}?${query}&FORMAT=json`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
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

  const sats = new Map(); // NORAD_CAT_ID -> OMM record (latest EPOCH wins on duplicates)
  const groups = {};

  function add(record) {
    const id = Number(record.NORAD_CAT_ID);
    if (!Number.isFinite(id)) return null;
    const prev = sats.get(id);
    if (!prev || String(record.EPOCH) > String(prev.EPOCH)) sats.set(id, record);
    return id;
  }

  for (const { id, celestrak } of GROUP_PLAN) {
    const records = await fetchGroup(celestrak);
    groups[id] = [...new Set(records.map(add).filter(id2 => id2 !== null))].sort((a, b) => a - b);
    log(`group ${id}: ${groups[id].length}`);
  }

  // Türkiye: pick the wanted ids out of the large `geo` group (not kept as a group itself).
  const wanted = new Set(TURKEY_IDS);
  const geo = await fetchGroup(TURKEY_SOURCE_GROUP);
  for (const record of geo) if (wanted.has(Number(record.NORAD_CAT_ID))) add(record);

  // Anything we must have (curated + Turkish) that the groups did not cover: one request each.
  const mustHave = [...new Set([...CURATED_IDS, ...TURKEY_IDS])];
  const missing = mustHave.filter(id => !sats.has(id));
  let completed = 0;
  for (const id of missing) {
    // The groups above are the essential part. If time is nearly up, publish what we have rather
    // than lose the whole run; the next run (2 h later) tries the remaining ids again.
    if (now() - startedAt > budgetMs) { log(`time budget reached; skipped ${missing.length - completed} individual lookups`); break; }
    const record = await fetchCatnr(id);
    completed++;
    if (record) add(record); else log(`no GP data for ${id}`);
  }
  log(`completed ${completed}/${missing.length} missing ids individually`);

  groups.turkey = TURKEY_IDS.filter(id => sats.has(id)).sort((a, b) => a - b);

  const satList = [...sats.values()].sort((a, b) => Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID));
  if (satList.length < minTotal) {
    throw new SnapshotAbort(`only ${satList.length} satellites (< ${minTotal}); refusing to publish`);
  }
  for (const g of requiredGroups) {
    if (!groups[g] || groups[g].length === 0) throw new SnapshotAbort(`required group "${g}" is empty; refusing to publish`);
  }

  return {
    schema: 1,
    generatedAt: new Date(now()).toISOString(),
    source: 'celestrak.org GP (JSON/OMM)',
    groups,
    sats: satList,
  };
}
