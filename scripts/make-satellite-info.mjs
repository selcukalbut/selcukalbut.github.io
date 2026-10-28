// Builds the static satellite facts + pictures shown by the website and the iPhone app:
//
//   assets/data/satellite-info.json   facts per NORAD id (owner, launch date/site, status, mass, makers, operators,
//                                     launch vehicles, Wikipedia links, picture credit)
//   assets/satellites/<id>.jpg        one picture per satellite, only where Wikimedia Commons has a picture
//                                     under a licence we accept (public domain / CC0 / CC BY / CC BY-SA)
//
//   npm run make-info [-- --snapshot <file|url>] [--no-images] [--refresh]
//
// Sources: CelesTrak SATCAT (ownership, launch, status), Wikidata (mass, manufacturer, operator, launch vehicle,
// links, picture), Wikimedia Commons (licence + thumbnail). Requests are sequential and identifiable; CelesTrak
// requests stop at the first failure (their usage policy). Raw responses are cached in .cache/satellite-info so
// re-running while iterating does not hit the sources again; --refresh ignores the cache.
// Picture conversion uses macOS `sips`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GROUP_PLAN, TURKEY_SOURCE_GROUP, CURATED_IDS, TURKEY_IDS } from '../netlify/lib/plan.mjs';
import {
  classifyLicense, stripHtml, commonsFileName, parseSatcat, wikidataQuery, labelsQuery,
  groupWikidataRows, groupLabelRows, buildInfo,
} from './lib/satellite-info.mjs';
import { OWNER_EN, OWNER_TR, SITE_EN, SITE_TR } from './lib/names-tr.mjs';

const UA = 'selcukalbut.com-satellite-tracker (+https://selcukalbut.com; selcuk@selcukalbut.com)';
const root = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cacheDir = `${root}.cache/satellite-info/`;
mkdirSync(cacheDir, { recursive: true });
mkdirSync(`${root}assets/satellites`, { recursive: true });

async function cached(key, fetcher) {
  const file = `${cacheDir}${createHash('sha1').update(key).digest('hex').slice(0, 16)}.txt`;
  if (!flag('refresh') && existsSync(file)) return readFileSync(file, 'utf8');
  const text = await fetcher();
  writeFileSync(file, text);
  return text;
}

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

// ---- which satellites ----
const snapshotSrc = opt('snapshot') || `${root}assets/data/gp-seed.json`;
const snapshot = /^https?:/.test(snapshotSrc) ? await (await get(snapshotSrc)).json() : JSON.parse(readFileSync(snapshotSrc, 'utf8'));
const ids = [...new Set(snapshot.sats.map(s => Number(s.NORAD_CAT_ID)))].sort((a, b) => a - b);
console.log(`${ids.length} satellites from ${snapshotSrc}`);

// ---- 1. CelesTrak SATCAT (sequential, stop at the first failure) ----
const satcat = new Map();
let satcatRequests = 0;
async function satcatQuery(query) {
  const text = await cached(`satcat:${query}`, async () => {
    if (satcatRequests++ > 0) await sleep(600);
    return (await get(`https://celestrak.org/satcat/records.php?${query}&FORMAT=json`)).text();
  });
  try { return JSON.parse(text); } catch { throw new Error(`SATCAT ${query}: not JSON (${text.slice(0, 80)})`); }
}
const wanted = new Set(ids);
for (const g of [...GROUP_PLAN.map(p => p.celestrak), TURKEY_SOURCE_GROUP]) {
  for (const [id, rec] of parseSatcat(await satcatQuery(`GROUP=${g}`))) if (wanted.has(id)) satcat.set(id, rec);
}
for (const id of ids.filter(i => !satcat.has(i))) {
  const rows = await satcatQuery(`CATNR=${id}`);
  for (const [k, rec] of parseSatcat(Array.isArray(rows) ? rows : [])) if (k === id) satcat.set(k, rec);
}
console.log(`SATCAT: ${satcat.size}/${ids.length} satellites`);

// ---- owner / launch-site names ----
function parseCodeTable(html) {
  const out = {};
  for (const row of html.match(/<tr[^>]*>.*?<\/tr>/gs) || []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(m => stripHtml(m[1]));
    if (cells.length >= 2 && cells[0] && !/code/i.test(cells[0])) out[cells[0]] = cells[1];
  }
  return out;
}
const ownerHtml = await cached('sources', async () => { await sleep(600); return (await get('https://celestrak.org/satcat/sources.php')).text(); });
const siteHtml = await cached('launchsites', async () => { await sleep(600); return (await get('https://celestrak.org/satcat/launchsites.php')).text(); });
const owners = Object.fromEntries(Object.entries(parseCodeTable(ownerHtml)).map(([c, en]) => [c, { en: OWNER_EN[c] || en, tr: OWNER_TR[c] || OWNER_EN[c] || en }]));
const sites = Object.fromEntries(Object.entries(parseCodeTable(siteHtml)).map(([c, en]) => [c, { en: SITE_EN[c] || en, tr: SITE_TR[c] || SITE_EN[c] || en }]));

// ---- 2. Wikidata ----
async function sparql(query) {
  const text = await cached(`sparql:${query}`, async () => {
    await sleep(400);
    const res = await get('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: new URLSearchParams({ query, format: 'json' }),
    });
    return res.text();
  });
  return JSON.parse(text).results.bindings;
}
let wdRows = [];
for (let i = 0; i < ids.length; i += 150) wdRows = wdRows.concat(await sparql(wikidataQuery(ids.slice(i, i + 150))));
const wikidata = groupWikidataRows(wdRows);
const qids = new Set();
for (const e of wikidata.values()) for (const set of [e.manufacturers, e.operators, e.vehicles]) set.forEach(q => qids.add(q));
let labelRows = [];
const qidList = [...qids].sort();
for (let i = 0; i < qidList.length; i += 150) labelRows = labelRows.concat(await sparql(labelsQuery(qidList.slice(i, i + 150))));
const labels = groupLabelRows(labelRows);
console.log(`Wikidata: ${wikidata.size} satellites, ${qidList.length} related entities`);

// ---- 3. Commons: licence check + picture ----
const images = new Map();
if (!flag('no-images')) {
  const candidates = [];   // { id, file }
  for (const [id, e] of wikidata) for (const url of e.images) { const f = commonsFileName(url); if (f) candidates.push({ id, file: f }); }
  const files = [...new Set(candidates.map(c => c.file))];
  const meta = new Map();  // file -> imageinfo
  for (let i = 0; i < files.length; i += 40) {
    const batch = files.slice(i, i + 40);
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '720',
      titles: batch.map(f => `File:${f}`).join('|'),
    });
    const text = await cached(`commons:${params}`, async () => { await sleep(300); return (await get(`https://commons.wikimedia.org/w/api.php?${params}`)).text(); });
    const data = JSON.parse(text).query;
    const alias = new Map((data.normalized || []).map(n => [n.to, n.from]));
    for (const page of data.pages || []) {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info) continue;
      const name = page.title.replace(/^File:/, '');
      meta.set(name, info);
      const from = alias.get(page.title);
      if (from) meta.set(from.replace(/^File:/, ''), info);
    }
  }
  for (const { id, file } of candidates) {
    if (images.has(id)) continue;
    const info = meta.get(file);
    if (!info) continue;
    const md = info.extmetadata || {};
    const lic = classifyLicense(md.LicenseShortName && md.LicenseShortName.value);
    if (!lic.ok || !['image/jpeg', 'image/png'].includes(info.mime) || !info.thumburl) continue;
    const out = `${root}assets/satellites/${id}.jpg`;
    const src = `${cacheDir}${id}.src`;
    if (!existsSync(out)) {
      if (!existsSync(src)) {
        await sleep(250);
        writeFileSync(src, Buffer.from(await (await get(info.thumburl)).arrayBuffer()));
      }
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '-Z', '640', src, '--out', out], { stdio: 'ignore' });
    }
    const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out]).toString();
    images.set(id, {
      file: `${id}.jpg`,
      width: Number(/pixelWidth: (\d+)/.exec(dims)[1]),
      height: Number(/pixelHeight: (\d+)/.exec(dims)[1]),
      title: file,
      author: stripHtml(md.Artist && md.Artist.value).slice(0, 160) || undefined,
      credit: stripHtml(md.Credit && md.Credit.value).slice(0, 160) || undefined,
      license: md.LicenseShortName.value,
      licenseUrl: (md.LicenseUrl && md.LicenseUrl.value) || undefined,
      attribution: lic.attribution,
      page: info.descriptionurl,
    });
  }
  console.log(`Commons: ${images.size} pictures accepted (of ${[...new Set(candidates.map(c => c.id))].length} satellites with one)`);
}

// ---- write ----
const doc = buildInfo({ ids, satcat, wikidata, labels, images, owners, sites, generatedAt: new Date().toISOString() });
writeFileSync(`${root}assets/data/satellite-info.json`, JSON.stringify(doc));
const curated = CURATED_IDS.filter(id => doc.sats[id]), withImg = Object.values(doc.sats).filter(s => s.image).length;
console.log(`wrote satellite-info.json: ${Object.keys(doc.sats).length} satellites, ${withImg} pictures; curated with info ${curated.length}/${CURATED_IDS.length}; Turkish ${TURKEY_IDS.filter(id => doc.sats[id]).length}/${TURKEY_IDS.length}`);
const missing = [...Object.keys(doc.owners).filter(c => !OWNER_TR[c]).map(c => `owner ${c}`), ...Object.keys(doc.sites).filter(c => !SITE_TR[c]).map(c => `site ${c}`)];
if (missing.length) console.log('codes without a Turkish name (fall back to English):', missing.join(', '));
