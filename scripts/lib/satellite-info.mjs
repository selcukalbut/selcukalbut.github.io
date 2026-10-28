// Pure helpers for scripts/make-satellite-info.mjs: turning CelesTrak SATCAT records, Wikidata rows and
// Wikimedia Commons metadata into the static `assets/data/satellite-info.json`. No network access here, so
// everything is unit-tested (see satellite-info.test.mjs).

export const SCHEMA = 1;

/**
 * Commons licences we are willing to show: public domain / CC0 (no conditions) and CC BY / CC BY-SA
 * (attribution required, which the apps show next to the picture and on a credits screen).
 * Anything else (NC, ND, GFDL-only, "copyrighted free use", unknown) is skipped.
 */
export function classifyLicense(shortName) {
  const s = String(shortName || '').trim().toLowerCase();
  if (!s) return { ok: false };
  if (s === 'public domain' || s === 'cc0' || /^cc0 /.test(s) || /^pd[-\s]/.test(s)) return { ok: true, attribution: false };
  if (/^cc by(-sa)? [0-9.]+( igo)?$/.test(s) || /^cc-by(-sa)?-[0-9.]+( igo)?$/.test(s)) return { ok: true, attribution: true };
  return { ok: false };
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', auml: 'ä', ccedil: 'ç', Ccedil: 'Ç', eacute: 'é', egrave: 'è',
  oslash: 'ø', aring: 'å', szlig: 'ß', iacute: 'í', oacute: 'ó', aacute: 'á', ntilde: 'ñ',
};

/** Commons / CelesTrak return HTML in some fields; keep the text only (tags dropped, entities decoded). */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `http://commons.wikimedia.org/wiki/Special:FilePath/Landsat%209%20model.png` -> `Landsat 9 model.png` */
export function commonsFileName(url) {
  const tail = String(url || '').split('/Special:FilePath/')[1];
  return tail ? decodeURIComponent(tail).replace(/_/g, ' ') : null;
}

/** SATCAT records -> Map(noradId -> compact record). */
export function parseSatcat(records) {
  const map = new Map();
  for (const r of records) {
    const id = Number(r.NORAD_CAT_ID);
    if (!Number.isFinite(id)) continue;
    map.set(id, {
      owner: r.OWNER || undefined,
      launchDate: r.LAUNCH_DATE || undefined,
      launchSite: r.LAUNCH_SITE || undefined,
      status: r.OPS_STATUS_CODE || undefined,
      decayDate: r.DECAY_DATE || undefined,
      objectType: r.OBJECT_TYPE || undefined,
    });
  }
  return map;
}

export function sparqlValues(ids) {
  return ids.map(id => `"${id}"`).join(' ');
}

export function wikidataQuery(ids) {
  return `SELECT ?id ?s ?img ?mass ?man ?op ?veh ?enwiki ?trwiki WHERE {
  VALUES ?id { ${sparqlValues(ids)} }
  ?s wdt:P377 ?id .
  OPTIONAL { ?s wdt:P18 ?img }
  OPTIONAL { ?s p:P2067/psn:P2067/wikibase:quantityAmount ?mass }
  OPTIONAL { ?s wdt:P176 ?man }
  OPTIONAL { ?s wdt:P137 ?op }
  OPTIONAL { ?s wdt:P375 ?veh }
  OPTIONAL { ?enw schema:about ?s ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enwiki }
  OPTIONAL { ?trw schema:about ?s ; schema:isPartOf <https://tr.wikipedia.org/> ; schema:name ?trwiki }
}`;
}

export function labelsQuery(qids) {
  // `en` falls back through other languages (Wikidata's label service) so an entity with only a French or Turkish
  // label still gets a readable name for English readers; `tr` is only ever a real Turkish label.
  return `SELECT ?q ?en ?tr WHERE {
  VALUES ?q { ${qids.map(q => `wd:${q}`).join(' ')} }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr,de,es,it,ru,tr,ja,zh,pt,nl". ?q rdfs:label ?en . }
  OPTIONAL { ?q rdfs:label ?tr FILTER(lang(?tr) = "tr") }
}`;
}

const qidOf = uri => (uri ? String(uri).split('/').pop() : null);
const val = (row, k) => (row[k] ? row[k].value : undefined);

/** SPARQL JSON bindings -> Map(noradId -> merged Wikidata facts). Several rows can exist per satellite. */
export function groupWikidataRows(bindings) {
  const map = new Map();
  for (const row of bindings) {
    const id = Number(val(row, 'id'));
    if (!Number.isFinite(id)) continue;
    let e = map.get(id);
    if (!e) {
      e = { qid: qidOf(val(row, 's')), images: new Set(), masses: [], manufacturers: new Set(), operators: new Set(), vehicles: new Set() };
      map.set(id, e);
    }
    const q = qidOf(val(row, 's'));
    // two Wikidata items can claim one SATCAT number; keep the first, it is the one with the most statements in practice
    if (q !== e.qid) continue;
    if (val(row, 'img')) e.images.add(val(row, 'img'));
    if (val(row, 'mass') && !e.masses.includes(Number(val(row, 'mass')))) e.masses.push(Number(val(row, 'mass')));
    if (val(row, 'man')) e.manufacturers.add(qidOf(val(row, 'man')));
    if (val(row, 'op')) e.operators.add(qidOf(val(row, 'op')));
    if (val(row, 'veh')) e.vehicles.add(qidOf(val(row, 'veh')));
    if (val(row, 'enwiki')) e.enwiki = val(row, 'enwiki');
    if (val(row, 'trwiki')) e.trwiki = val(row, 'trwiki');
  }
  return map;
}

export function groupLabelRows(bindings) {
  const map = {};
  for (const row of bindings) {
    const q = qidOf(val(row, 'q'));
    if (!q) continue;
    let en = val(row, 'en');
    const tr = val(row, 'tr');
    if (en && /^Q\d+$/.test(en)) en = undefined;   // the label service answers with the id when nothing exists
    map[q] = { ...map[q], ...(en ? { en } : {}), ...(tr ? { tr } : {}) };
  }
  return map;
}

const wikiUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

/**
 * Assemble the info document.
 * @param {object} o
 * @param {number[]} o.ids          satellites to describe
 * @param {Map} o.satcat            from parseSatcat
 * @param {Map} o.wikidata          from groupWikidataRows
 * @param {object} o.labels         { Q: {en, tr} }
 * @param {Map} o.images            noradId -> accepted image record { file, width, height, title, author, credit, license, licenseUrl, descriptionUrl, attribution }
 * @param {object} o.owners         { CODE: {en, tr} } for every owner code we may meet
 * @param {object} o.sites          { CODE: {en, tr} }
 */
export function buildInfo({ ids, satcat, wikidata, labels, images, owners, sites, generatedAt }) {
  const sats = {};
  const usedOwners = new Set(), usedSites = new Set(), usedQids = new Set();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const sc = satcat.get(id) || {};
    const wd = wikidata.get(id);
    const entry = {};
    if (sc.owner) { entry.owner = sc.owner; usedOwners.add(sc.owner); }
    if (sc.launchDate) entry.launchDate = sc.launchDate;
    if (sc.launchSite) { entry.launchSite = sc.launchSite; usedSites.add(sc.launchSite); }
    if (sc.status) entry.status = sc.status;
    if (sc.decayDate) entry.decayDate = sc.decayDate;
    if (wd) {
      entry.wikidata = wd.qid;
      if (wd.masses.length) entry.massKg = Math.round(Math.max(...wd.masses));
      for (const [key, set] of [['manufacturers', wd.manufacturers], ['operators', wd.operators], ['launchVehicles', wd.vehicles]]) {
        const list = [...set].filter(q => labels[q] && (labels[q].en || labels[q].tr));
        if (list.length) { entry[key] = list; list.forEach(q => usedQids.add(q)); }
      }
      if (wd.enwiki || wd.trwiki) {
        entry.wiki = {};
        if (wd.enwiki) entry.wiki.en = wikiUrl('en', wd.enwiki);
        if (wd.trwiki) entry.wiki.tr = wikiUrl('tr', wd.trwiki);
      }
    }
    const img = images.get(id);
    if (img) entry.image = img;
    if (Object.keys(entry).length) sats[id] = entry;
  }
  const pick = (table, used) => Object.fromEntries([...used].sort().map(c => [c, table[c] || { en: c }]));
  return {
    schema: SCHEMA,
    generatedAt,
    sources: [
      { name: 'CelesTrak SATCAT', url: 'https://celestrak.org/satcat/' },
      { name: 'Wikidata (CC0)', url: 'https://www.wikidata.org/' },
      { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
    ],
    owners: pick(owners, usedOwners),
    sites: pick(sites, usedSites),
    entities: Object.fromEntries([...usedQids].sort().map(q => [q, labels[q]])),
    sats,
  };
}
