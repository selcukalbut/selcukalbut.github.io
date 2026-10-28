import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLicense, stripHtml, commonsFileName, parseSatcat, groupWikidataRows, groupLabelRows, buildInfo, wikidataQuery,
} from './satellite-info.mjs';

test('licence allow-list: public domain / CC0 / CC BY / CC BY-SA only', () => {
  for (const ok of ['Public domain', 'CC0', 'PD-USGov-NASA', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-SA 3.0 IGO', 'CC BY 2.0']) {
    assert.equal(classifyLicense(ok).ok, true, ok);
  }
  assert.equal(classifyLicense('Public domain').attribution, false);
  assert.equal(classifyLicense('CC BY-SA 4.0').attribution, true);
  for (const bad of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'GFDL', 'Copyrighted free use', 'Fair use', '', undefined, 'ESA standard licence']) {
    assert.equal(classifyLicense(bad).ok, false, String(bad));
  }
});

test('stripHtml / commonsFileName', () => {
  assert.equal(stripHtml('<a href="x">NASA/Goddard</a> &amp; <b>Lab</b>'), 'NASA/Goddard & Lab');
  assert.equal(stripHtml('T&uuml;rkiye &mdash; &#305;&#x131; &unknown;'), 'Türkiye — ıı &unknown;');
  assert.equal(commonsFileName('http://commons.wikimedia.org/wiki/Special:FilePath/Landsat%209%20spacecraft%20model_1.png'), 'Landsat 9 spacecraft model 1.png');
  assert.equal(commonsFileName('nonsense'), null);
});

test('parseSatcat keeps the fields we show', () => {
  const m = parseSatcat([{ NORAD_CAT_ID: 25544, OWNER: 'ISS', LAUNCH_DATE: '1998-11-20', LAUNCH_SITE: 'TYMSC', OPS_STATUS_CODE: '+', DECAY_DATE: '' }, { NORAD_CAT_ID: 'x' }]);
  assert.deepEqual(m.get(25544), { owner: 'ISS', launchDate: '1998-11-20', launchSite: 'TYMSC', status: '+', decayDate: undefined, objectType: undefined });
  assert.equal(m.size, 1);
});

const row = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

test('groupWikidataRows merges multi-valued rows and ignores a second item for the same id', () => {
  const m = groupWikidataRows([
    row({ id: '49260', s: 'http://www.wikidata.org/entity/Q1', img: 'http://commons.wikimedia.org/wiki/Special:FilePath/A.png', mass: '2864', man: 'http://www.wikidata.org/entity/Q10', veh: 'http://www.wikidata.org/entity/Q30' }),
    row({ id: '49260', s: 'http://www.wikidata.org/entity/Q1', mass: '2864', man: 'http://www.wikidata.org/entity/Q11', op: 'http://www.wikidata.org/entity/Q20', enwiki: 'Landsat 9' }),
    row({ id: '49260', s: 'http://www.wikidata.org/entity/Q2', mass: '1' }),
  ]);
  const e = m.get(49260);
  assert.equal(e.qid, 'Q1');
  assert.deepEqual([...e.manufacturers].sort(), ['Q10', 'Q11']);
  assert.deepEqual(e.masses, [2864]);
  assert.equal(e.enwiki, 'Landsat 9');
});

test('buildInfo: only entities with labels, picture and credit carried over, empty satellites dropped', () => {
  const satcat = new Map([[1, { owner: 'US', launchDate: '2021-09-27', launchSite: 'AFWTR', status: '+' }]]);
  const wikidata = groupWikidataRows([
    row({ id: '1', s: 'http://www.wikidata.org/entity/Q1', mass: '2864.4', man: 'http://www.wikidata.org/entity/Q10', op: 'http://www.wikidata.org/entity/Q99', enwiki: 'Landsat 9', trwiki: 'Landsat 9 (uydu)' }),
  ]);
  const labels = groupLabelRows([row({ q: 'http://www.wikidata.org/entity/Q10', en: 'Northrop Grumman', tr: 'Northrop Grumman' })]);
  const images = new Map([[1, { file: '1.jpg', width: 720, height: 405, license: 'Public domain', attribution: false }]]);
  const doc = buildInfo({
    ids: [1, 2], satcat, wikidata, labels, images,
    owners: { US: { en: 'United States', tr: 'Amerika Birleşik Devletleri' } }, sites: { AFWTR: { en: 'Vandenberg', tr: 'Vandenberg' } },
    generatedAt: '2026-10-29T00:00:00Z',
  });
  assert.deepEqual(Object.keys(doc.sats), ['1']);
  const s = doc.sats[1];
  assert.equal(s.massKg, 2864);
  assert.deepEqual(s.manufacturers, ['Q10']);
  assert.equal(s.operators, undefined, 'Q99 has no label so it is dropped');
  assert.equal(s.wiki.tr, 'https://tr.wikipedia.org/wiki/Landsat_9_(uydu)');
  assert.equal(s.image.file, '1.jpg');
  assert.equal(doc.owners.US.tr, 'Amerika Birleşik Devletleri');
  assert.deepEqual(Object.keys(doc.entities), ['Q10']);
});

test('groupLabelRows drops placeholder ids the label service returns', () => {
  const l = groupLabelRows([row({ q: 'http://www.wikidata.org/entity/Q5', en: 'Q5' }), row({ q: 'http://www.wikidata.org/entity/Q6', en: 'Goddard', tr: 'Goddard Uzay Uçuş Merkezi' })]);
  assert.deepEqual(l.Q5, {});
  assert.deepEqual(l.Q6, { en: 'Goddard', tr: 'Goddard Uzay Uçuş Merkezi' });
});

test('wikidataQuery lists the ids as strings', () => {
  assert.match(wikidataQuery([25544, 49260]), /VALUES \?id \{ "25544" "49260" \}/);
});
