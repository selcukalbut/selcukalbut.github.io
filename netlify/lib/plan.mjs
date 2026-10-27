// What the satellite snapshot contains. Changing the tracker's coverage means editing this file
// (plus the matching group/curated metadata in index.html).

export const CELESTRAK_GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';

// Identifies us to CelesTrak (their usage policy asks for well-behaved, identifiable clients).
export const USER_AGENT = 'selcukalbut.com-satellite-tracker (+https://selcukalbut.com)';

// Our group id -> CelesTrak GROUP name. Every group is requested once per run; membership in the
// snapshot is exactly what CelesTrak returns for that group.
export const GROUP_PLAN = [
  { id: 'stations', celestrak: 'stations' },
  { id: 'gps', celestrak: 'gps-ops' },
  { id: 'glonass', celestrak: 'glo-ops' },
  { id: 'galileo', celestrak: 'galileo' },
  { id: 'beidou', celestrak: 'beidou' },
  { id: 'weather', celestrak: 'weather' },
  { id: 'resource', celestrak: 'resource' },
  { id: 'sar', celestrak: 'sar' },
  { id: 'science', celestrak: 'science' },
];

// Turkish satellites. Türksat 3A–6A live in CelesTrak's large `geo` group, which is fetched only to
// pick these out (it is not exposed as a group of its own).
export const TURKEY_SOURCE_GROUP = 'geo';
export const TURKEY_IDS = [
  33056, // TÜRKSAT 3A
  39522, // TÜRKSAT 4A
  40984, // TÜRKSAT 4B
  47306, // TÜRKSAT 5A
  50212, // TÜRKSAT 5B
  60233, // TÜRKSAT 6A
  56178, // İMECE
  55012, // CONNECTA T1.2
  37791, // RASAT
  41875, // GÖKTÜRK-1
  39030, // GÖKTÜRK-2
];

// The 53 hand-curated satellites already described in index.html (SATELLITES_RAW). They must
// always be in the snapshot; any that the groups above do not cover are fetched individually
// by NORAD id. A test keeps this list in sync with index.html.
export const CURATED_IDS = [
  25682, 25994, 27424, 29268, 31598, 32060, 32382, 33331, 33396, 35681, 35946, 36605, 37387,
  38012, 38338, 38755, 39019, 39030, 39084, 39150, 39227, 39634, 39731, 39766, 40010, 40013,
  40053, 40115, 40118, 40536, 40697, 40961, 41194, 41601, 41727, 41875, 42920, 43099, 43111,
  43152, 43215, 43441, 43484, 43890, 44072, 44703, 44804, 49260, 52159, 52184, 54880, 57693,
  60182,
];

// Safety rails: a snapshot that fails these is never published (the previous one stays live).
export const MIN_TOTAL_SATS = 400;
export const REQUIRED_GROUPS = ['stations', 'gps', 'galileo', 'weather', 'resource', 'sar'];

// CelesTrak usage policy: be gentle, and stop at the first failure. Scheduled functions are killed
// at 30 s, so no new request starts after TIME_BUDGET_MS; the last one can still take up to
// REQUEST_TIMEOUT_MS (+ the gap and the blob write), which keeps the worst case under the limit.
export const REQUEST_GAP_MS = 500;
export const TIME_BUDGET_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 6_000;

// CelesTrak publishes new GP data every 2 hours and asks for each dataset at most once per update.
// A source (group) is "due" once its last fetch is at least this old (a little under 2 h so an
// hourly schedule always lands on the next update). A run with nothing due makes no requests.
export const SOURCE_MIN_AGE_MS = 110 * 60 * 1000;

// Satellites that no group covers (some curated ones, İMECE, Connecta) cost one request each. Ones
// never seen before are always fetched; after that a run only refreshes those older than this, at
// most MAX_INDIVIDUAL_PER_RUN of them. Orbital elements this old are still fine for a
// visualisation (LEO drift is a few km per day).
export const INDIVIDUAL_MAX_AGE_MS = 6 * 3600 * 1000;
export const MAX_INDIVIDUAL_PER_RUN = 5;
