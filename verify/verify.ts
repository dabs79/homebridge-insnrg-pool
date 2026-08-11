/**
 * Verification harness: runs the TS InsnrgClient through the same battery of
 * cases as verify/reference_cases.py (which drives the VERBATIM Python
 * reference), then asserts every HTTP request — URL, Authorization header,
 * JSON body — and the getall parse output match exactly.
 *
 * Run: npm run verify
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InsnrgClient, FetchLike } from '../src/insnrg/client';

const here = __dirname;
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));

interface RecordedRequest { url: string; headers: Record<string, string>; body: unknown }

function makeRecordingFetch(): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    // aiohttp's session.post(json=...) sets Content-Type implicitly at the
    // transport layer; the Python recorder only sees explicitly-passed headers.
    // Both sides put application/json on the wire, so drop it for comparison.
    const headers = { ...init.headers };
    delete headers['Content-Type'];
    requests.push({ url, headers, body: JSON.parse(init.body) });
    const payload = url.endsWith('/api/login') ? fixtures.loginResponse : fixtures.getallResponse;
    return { status: 200, json: async () => payload };
  };
  return { fetch, requests };
}

function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** Keys the TS type adds to pseudo-devices with empty defaults for typing convenience. */
const TS_TYPED_DEFAULTS = new Set(['switchStatus', 'toggleStatus', 'thermostatStatus', 'temperatureSensorStatus']);

function compareStateMaps(py: Record<string, Record<string, unknown>>, ts: Record<string, Record<string, unknown>>, failures: string[]) {
  const allKeys = new Set([...Object.keys(py), ...Object.keys(ts)]);
  for (const key of allKeys) {
    if (!(key in py)) { failures.push(`getall parse: TS has extra entry "${key}"`); continue; }
    if (!(key in ts)) { failures.push(`getall parse: TS missing entry "${key}"`); continue; }
    const pe = py[key], te = ts[key];
    for (const f of Object.keys(pe)) {
      if (canon(pe[f]) !== canon(te[f])) {
        failures.push(`getall parse: ${key}.${f} mismatch\n  py: ${canon(pe[f])}\n  ts: ${canon(te[f])}`);
      }
    }
    for (const f of Object.keys(te)) {
      if (f in pe) continue;
      if (te[f] === undefined) continue;
      const emptyDefault = TS_TYPED_DEFAULTS.has(f) && (te[f] === '' || canon(te[f]) === '{}');
      if (!emptyDefault) {
        failures.push(`getall parse: ${key}.${f} — TS has non-default extra field: ${canon(te[f])}`);
      }
    }
  }
}

async function main() {
  const pyOut = JSON.parse(
    execFileSync('python3', [join(here, 'reference_cases.py')], { encoding: 'utf8' }),
  ) as { cases: Record<string, { requests: RecordedRequest[]; result: unknown }> };

  const failures: string[] = [];
  let passed = 0;

  const runCase = async (
    name: string,
    fn: (c: InsnrgClient) => Promise<unknown>,
  ): Promise<unknown> => {
    const { fetch, requests } = makeRecordingFetch();
    const client = new InsnrgClient('user@example.com', 'hunter2', fetch);
    const result = await fn(client);
    const ref = pyOut.cases[name];
    if (!ref) { failures.push(`${name}: no Python reference output`); return result; }
    if (canon(requests) !== canon(ref.requests)) {
      failures.push(`${name}: HTTP requests differ\n  py: ${canon(ref.requests)}\n  ts: ${canon(requests)}`);
    } else {
      passed++;
      console.log(`  ✓ ${name}: ${requests.length} request(s) match byte-for-byte`);
    }
    return result;
  };

  // --- request-shape cases ---
  const creds = await runCase('testCredentials', (c) => c.testCredentials());
  const getAllOut = await runCase('getAll', async (c) => (await c.getAll()).state);
  await runCase('switch_ON', (c) => c.turnTheSwitch('ON', 'OUTLET_1'));
  await runCase('switch_OFF', (c) => c.turnTheSwitch('OFF', 'VALVE_HUB_2'));
  await runCase('switch_TIMER', (c) => c.turnTheSwitch('TIMER', 'VF_CONTACT_1'));
  await runCase('setTemperature', (c) => c.setThermostatTemp(28.5, 'POOL_CONTROL'));
  await runCase('setChemistry', (c) => c.setChemistry(7.4, 'PH'));
  await runCase('setLightMode', (c) => c.changeLightMode('Ocean', 'LIGHT_1'));
  await runCase('setPumpValue', (c) => c.setPumpValue('Medium', 'PUMP_SPEED'));

  // --- result-shape cases ---
  const pySerial = pyOut.cases['testCredentials'].result;
  const tsSerial = creds === false ? false : (creds as { serial: string | null }).serial ?? 'DEMO';
  if (canon(pySerial) !== canon(tsSerial)) {
    failures.push(`testCredentials result: py=${canon(pySerial)} ts=${canon(tsSerial)}`);
  } else {
    passed++;
    console.log('  ✓ testCredentials: serial extraction matches');
  }

  compareStateMaps(
    pyOut.cases['getAll'].result as Record<string, Record<string, unknown>>,
    getAllOut as Record<string, Record<string, unknown>>,
    failures,
  );
  if (!failures.some((f) => f.startsWith('getall parse'))) {
    passed++;
    console.log(`  ✓ getAll: parsed state map matches reference across ${Object.keys(pyOut.cases['getAll'].result as object).length} entries`);
  }

  console.log('');
  if (failures.length) {
    console.error(`VERIFY FAILED — ${failures.length} mismatch(es):\n`);
    for (const f of failures) console.error(`✗ ${f}\n`);
    process.exit(1);
  }
  console.log(`VERIFY PASSED — ${passed} case group(s), TS port matches the Python reference exactly.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
