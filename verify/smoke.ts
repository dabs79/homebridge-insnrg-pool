/**
 * HAP smoke test: instantiate every accessory type against REAL hap-nodejs
 * (the same characteristic validation Homebridge runs) using fixture state,
 * then drive update() twice. Catches "value exceeded minimum/maximum" and
 * setProps-ordering errors here instead of on the user's Homebridge.
 *
 * Run: npm run verify (second stage)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// hap-nodejs ships as a dependency of homebridge
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hap = require('hap-nodejs');

import { parseGetAll, InsnrgStateMap } from '../src/insnrg/parse';
import { ThermostatAccessory } from '../src/accessories/thermostatAccessory';
import { SwitchAccessory } from '../src/accessories/switchAccessory';
import { LightAccessory } from '../src/accessories/lightAccessory';
import { SteppedFanAccessory } from '../src/accessories/steppedFanAccessory';
import { ChemistrySensorAccessory } from '../src/accessories/chemistrySensorAccessory';

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'));
const state: InsnrgStateMap = parseGetAll(fixtures.getallResponse);

// Minimal PlatformAccessory shim over a hap Accessory.
class FakePlatformAccessory {
  private acc = new hap.Accessory('Test', hap.uuid.generate(`test-${Math.random()}`));
  displayName = 'Test';
  getService(s: unknown) { return this.acc.getService(s); }
  addService(ctor: unknown, name?: string, subtype?: string) {
    return this.acc.addService(new (ctor as new (n?: string, s?: string) => unknown)(name, subtype));
  }
  getServiceById(ctor: unknown, subtype: string) { return this.acc.getServiceById(ctor, subtype); }
  removeService(s: unknown) { this.acc.removeService(s); }
}

const logged: string[] = [];
const fakePlatform = {
  Service: hap.Service,
  Characteristic: hap.Characteristic,
  log: {
    info: (m: string) => logged.push(m),
    debug: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(`ERROR: ${m}`),
  },
  cfg: {
    pollIntervalSeconds: 300, setpointMin: 10, setpointMax: 40,
    exposeTimerSwitches: true, exposeTimers: true, exposeLightModes: true,
    exposeChemistrySensors: true, exposeChlorinator: true, debug: false,
  },
  client: {
    setThermostatTemp: async () => {}, turnTheSwitch: async () => {},
    changeLightMode: async () => {}, setPumpValue: async () => {}, setChemistry: async () => {},
  },
  requestRefreshSoon: () => {},
  sendSwitch: async () => {},
} as never;

let failures = 0;
function tryCase(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.stack : e}`);
  }
}

function acc() { return new FakePlatformAccessory() as never; }

tryCase('Thermostat POOL_CONTROL (normal range)', () => {
  const a = new ThermostatAccessory(fakePlatform, acc(), 'POOL_CONTROL', 'Pool');
  a.update(state['POOL_CONTROL']);
  a.update(state['POOL_CONTROL']);
});

tryCase('Thermostat with implausible device range (sanitiser path)', () => {
  const a = new ThermostatAccessory(fakePlatform, acc(), 'SPA_CONTROL', 'Spa');
  const bad = JSON.parse(JSON.stringify(state['SPA_CONTROL']));
  bad.thermostatStatus.valueMin = 16; bad.thermostatStatus.valueMax = 16; // AirTouch-style placeholder
  a.update(bad);
  bad.thermostatStatus.valueMin = 10; bad.thermostatStatus.valueMax = 40;
  a.update(bad); // range widens later — must not throw
});

tryCase('Thermostat with missing/NaN temps', () => {
  const a = new ThermostatAccessory(fakePlatform, acc(), 'POOL_CONTROL', 'Pool');
  const bad = JSON.parse(JSON.stringify(state['POOL_CONTROL']));
  bad.temperatureSensorStatus = {}; bad.thermostatStatus = {};
  a.update(bad);
});

tryCase('Switch with timer sub-switch (OUTLET_1)', () => {
  const a = new SwitchAccessory(fakePlatform, acc(), 'OUTLET_1', 'Waterfall', true);
  a.update(state['OUTLET_1']);
});

tryCase('Switch ON/OFF-only (SPA)', () => {
  const a = new SwitchAccessory(fakePlatform, acc(), 'SPA', 'SPA', false);
  a.update(state['SPA']);
});

tryCase('Light with mode switches', () => {
  const a = new LightAccessory(fakePlatform, acc(), 'LIGHT_1', 'Pool Light');
  a.update(state['LIGHT_1'], state);
  a.update(state['LIGHT_1'], state);
});

tryCase('Stepped fan PUMP_SPEED (3 levels)', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'PUMP_SPEED', 'Pump Speed');
  a.update(state['PUMP_SPEED']);
  a.update(state['PUMP_SPEED']);
});

tryCase('Stepped fan CHLORINATOR (8 levels)', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'CHLORINATOR', 'Chlorinator Level');
  a.update(state['CHLORINATOR']);
});

tryCase('Stepped fan with empty modeList', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'PUMP_SPEED', 'Pump Speed');
  const bad = JSON.parse(JSON.stringify(state['PUMP_SPEED']));
  delete bad.modeList;
  a.update(bad);
});

tryCase('pH sensor (string value)', () => {
  const a = new ChemistrySensorAccessory(fakePlatform, acc(), 'PH', 'Current pH');
  a.update(state['PH']);
});

tryCase('ORP sensor + blank reading', () => {
  const a = new ChemistrySensorAccessory(fakePlatform, acc(), 'ORP', 'Current ORP');
  a.update(state['ORP']);
  const blank = JSON.parse(JSON.stringify(state['ORP']));
  blank.temperatureSensorStatus.value = ' ';
  a.update(blank); // the reference treats ' ' as no reading — must clamp, not throw
});

console.log('');
if (failures) {
  console.error(`SMOKE FAILED — ${failures} accessory case(s) threw under real HAP validation.`);
  process.exit(1);
}
console.log('SMOKE PASSED — all accessories construct and update cleanly under real hap-nodejs validation.');
