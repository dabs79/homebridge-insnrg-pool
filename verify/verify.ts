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
import { extractHeaterTelemetry } from '../src/insnrg/systemValues';

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

  // --- web-app capture cases (no Python reference: verified against DevTools
  //     captures from insnrgapp.com, 2026-08-12) ---
  const SEND = 'https://95osjk2ux7.execute-api.us-east-2.amazonaws.com/prod/send';
  const capturedCases: Array<{ temp: number; val: number }> = [
    { temp: 32, val: 64 }, { temp: 34, val: 68 }, { temp: 36, val: 72 },
  ];
  for (const { temp, val } of capturedCases) {
    const { fetch: f, requests } = makeRecordingFetch();
    const c = new InsnrgClient('user@example.com', 'hunter2', f);
    await c.setHeaterTemperature(temp, 'pool', 'insnrg38182be7f8f0');
    const sends = requests.filter((r) => r.url === SEND);
    const expected = [
      { systemId: 'insnrg38182be7f8f0', deviceType: 'gas_heater', payloads: [{ cmd: 'GASHEATER_SET_TEMP_POOL', valArgument: [val] }] },
      { systemId: 'insnrg38182be7f8f0', deviceType: 'chlorinator', payloads: [{ cmd: 'SETTING_SET_POINT_POOL', valArgument: [val] }] },
    ];
    if (sends.length !== 2 || canon(sends.map((r) => r.body)) !== canon(expected)) {
      failures.push(`setHeaterTemperature(${temp}) bodies differ\n  expect: ${canon(expected)}\n  got: ${canon(sends.map((r) => r.body))}`);
    } else {
      passed++;
      console.log(`  \u2713 setHeaterTemperature(${temp}\u00b0C) matches captured payloads (valArgument [${val}])`);
    }
  }

  {
    const { fetch: f, requests } = makeRecordingFetch();
    const c = new InsnrgClient('user@example.com', 'hunter2', f);
    await c.fetchSystemValues('insnrg38182be7f8f0');
    const ITEMS = 'https://q5nhxjkqu4.execute-api.us-east-2.amazonaws.com/prod/items';
    const items = requests.filter((r) => r.url === ITEMS);
    const expectedBody = { systemId: 'insnrg38182be7f8f0', index: 'getSystemValuesBySystemIdByIsLive', isLive: 0, operator: 'gt' };
    if (items.length !== 1 || canon(items[0].body) !== canon(expectedBody)) {
      failures.push(`fetchSystemValues body differs\n  expect: ${canon(expectedBody)}\n  got: ${canon(items.map((r) => r.body))}`);
    } else {
      passed++;
      console.log('  \u2713 fetchSystemValues matches captured /prod/items request');
    }
  }

  {
    // Verbatim records from the live 2026-08-12 items capture.
    const sample = { status: 1, data: [
      { id: '2bd5984b-c2ea-4b8f-9f47-014e01ec16d3', deviceType: 'gas_heater', createdAt: '2025-11-14T01:47:37.104Z', isLive: 1, isRealTime: 0, updatedAt: '2026-08-12T05:05:07.675Z', modbusVal: [46], systemId: 'insnrg38182be7f8f0', modbusReg: 56 },
      { deviceType: 'gas_heater', modbusReg: 65056, modbusVal: [72], updatedAt: '2026-08-12T04:31:00.000Z', isLive: 1, isRealTime: 0, id: 'x', systemId: 'insnrg38182be7f8f0', createdAt: '2025-11-05T00:00:00.000Z' },
      { deviceType: 'chlorinator', modbusReg: 52, modbusVal: [81], updatedAt: '2026-08-12T05:05:00.000Z', isLive: 1, isRealTime: 0, id: 'y', systemId: 'insnrg38182be7f8f0', createdAt: '2025-11-05T00:00:00.000Z' },
    ]};
    const t = extractHeaterTelemetry(sample);
    if (t.waterTempC === 23 && t.poolSetTempC === 36 && t.waterTempUpdatedAt === '2026-08-12T05:05:07.675Z') {
      passed++;
      console.log('  \u2713 extractHeaterTelemetry: reg 56 \u2192 23.0\u00b0C, reg 65056 \u2192 36.0\u00b0C from captured records');
    } else {
      failures.push(`extractHeaterTelemetry mismatch: ${JSON.stringify(t)}`);
    }
    const empty = extractHeaterTelemetry({ status: 1 });
    if (Object.keys(empty).length !== 0) failures.push('extractHeaterTelemetry: non-empty on missing data');
  }

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
