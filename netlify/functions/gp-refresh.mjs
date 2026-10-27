import { getStore } from '@netlify/blobs';
import { buildSnapshot } from '../lib/snapshot.mjs';

// Runs hourly, but only fetches the CelesTrak sources that are due (CelesTrak publishes every 2 h
// and its usage policy says to download each set at most once per update), so most runs make no
// requests at all. An hourly tick also means a source that failed or timed out is retried an hour
// later instead of two. Visitors never talk to CelesTrak: they read the snapshot stored here, via
// /api/gp.
export default async () => {
  try {
    const store = getStore('gp');
    const previous = await store.get('snapshot', { type: 'json' }).catch(() => null);
    const snapshot = await buildSnapshot({ previous, log: msg => console.log(`gp-refresh: ${msg}`) });
    if (!snapshot) return; // nothing due
    await store.setJSON('snapshot', snapshot);
    console.log(`gp-refresh: stored ${snapshot.sats.length} satellites in ${Object.keys(snapshot.groups).length} groups (${snapshot.generatedAt})`);
  } catch (err) {
    // Keep serving the previous snapshot; CelesTrak asks clients to stop (not retry) on errors.
    console.error(`gp-refresh: aborted, previous snapshot kept — ${err.message}`);
  }
};

// minute 17 (not the top of the hour) to stay out of everyone else's cron herd
export const config = { schedule: '17 * * * *' };
