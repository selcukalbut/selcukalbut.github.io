import { getStore } from '@netlify/blobs';
import { buildSnapshot } from '../lib/snapshot.mjs';

// Runs every 2 hours (CelesTrak refreshes GP data on that cadence and its usage policy says
// to download each set at most once per update). Visitors never talk to CelesTrak: they read
// the snapshot this function stores, via /api/gp.
export default async () => {
  try {
    const store = getStore('gp');
    const previous = await store.get('snapshot', { type: 'json' }).catch(() => null);
    const snapshot = await buildSnapshot({ previous, log: msg => console.log(`gp-refresh: ${msg}`) });
    await store.setJSON('snapshot', snapshot);
    console.log(`gp-refresh: stored ${snapshot.sats.length} satellites in ${Object.keys(snapshot.groups).length} groups (${snapshot.generatedAt})`);
  } catch (err) {
    // Keep serving the previous snapshot; CelesTrak asks clients to stop (not retry) on errors.
    console.error(`gp-refresh: aborted, previous snapshot kept — ${err.message}`);
  }
};

// minute 17 (not the top of the hour) to stay out of everyone else's cron herd
export const config = { schedule: '17 */2 * * *' };
