// Generates assets/data/gp-seed.json: a one-off snapshot committed to the repo as a last-resort
// fallback for the tracker (used only if /api/gp and the browser cache are both unavailable, and
// handy for local development with a plain static server).
//
//   npm run make-seed
//
// This talks to CelesTrak (≈15–20 sequential requests). CelesTrak's usage policy asks for each
// dataset to be downloaded at most once per 2-hour update, so don't run it repeatedly.

import { writeFileSync } from 'node:fs';
import { buildSnapshot } from '../netlify/lib/snapshot.mjs';

const out = new URL('../assets/data/gp-seed.json', import.meta.url);
const snapshot = await buildSnapshot({ log: msg => console.log(msg) });
writeFileSync(out, JSON.stringify(snapshot));
console.log(`wrote ${snapshot.sats.length} satellites (${Object.entries(snapshot.groups).map(([g, ids]) => `${g}:${ids.length}`).join(' ')}) -> ${out.pathname}`);
