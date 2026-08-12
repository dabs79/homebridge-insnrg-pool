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
import { GasHeaterAccessory } from '../src/accessories/gasHeaterAccessory';
import { WaterTempSensorAccessory } from '../src/accessories/waterTempSensorAccessory';

const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'));
const state: InsnrgStateMap = parseGetAll(fixtures.getallResponse);

// Minimal PlatformAccessory shim over a hap Accessory.
const hapWarnings: string[] = [];
const builtAccessories: FakePlatformAccessory[] = [];

/** Apple-defined valid ranges; advertising outside these makes Apple clients
 *  reject the entire bridge (learned the hard way in v1.5.x). */
const APPLE_RANGES: Record<string, [number, number]> = {
  TargetTemperature: [10, 38],
  CurrentTemperature: [-270, 100],
  RotationSpeed: [0, 100],
  CurrentAmbientLightLevel: [0.0001, 100000],
  TargetRelativeHumidity: [0, 100],
  CurrentRelativeHumidity: [0, 100],
};
function checkAppleRanges(): string[] {
  const problems: string[] = [];
  for (const fpa of builtAccessories) {
    for (const svc of (fpa as unknown as { services(): Array<{ characteristics: Array<{ displayName: string; props: { minValue?: number; maxValue?: number } }> }> }).services()) {
      for (const ch of svc.characteristics) {
        const range = APPLE_RANGES[ch.displayName.replace(/ /g, '')];
        if (!range) continue;
        const { minValue, maxValue } = ch.props;
        if (typeof minValue === 'number' && minValue < range[0]) {
          problems.push(`${ch.displayName}: minValue ${minValue} below Apple minimum ${range[0]}`);
        }
        if (typeof maxValue === 'number' && maxValue > range[1]) {
          problems.push(`${ch.displayName}: maxValue ${maxValue} above Apple maximum ${range[1]}`);
        }
      }
    }
  }
  return problems;
}
class FakePlatformAccessory {
  services() { return this.acc.services; }
  private acc = (() => {
    const a = new hap.Accessory('Test', hap.uuid.generate(`test-${Math.random()}`));
    a.on('characteristic-warning', (w: { message: string }) => hapWarnings.push(w.message));
    return a;
  })();
  displayName = 'Test';
  context: Record<string, unknown> = {};
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
    pollIntervalSeconds: 300, setpointMin: 10, setpointMax: 38,
    exposeTimerSwitches: true, exposeTimers: true, exposeLightModes: true,
    exposeChemistrySensors: true, exposeChlorinator: true, chemistrySetpoints: true, debug: false,
  },
  client: {
    setThermostatTemp: async () => {}, turnTheSwitch: async () => {},
    changeLightMode: async () => {}, setPumpValue: async () => {}, setChemistry: async () => {}, setHeaterTemperature: async () => {},
  },
  requestRefreshSoon: () => {},
  systemId: 'insnrg38182be7f8f0',
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

function acc() {
  const a = new FakePlatformAccessory();
  builtAccessories.push(a);
  return a as never;
}

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

tryCase('Switch with timer sub-switch (MODE / Filter Pump)', () => {
  const a = new SwitchAccessory(fakePlatform, acc(), 'MODE', 'Filter Pump', true);
  a.update(state['MODE']);
});

tryCase('Pool Temperature sensor (fresh + stale + missing telemetry)', () => {
  const a = new WaterTempSensorAccessory(fakePlatform, acc(), 'Pool Temperature');
  a.updateTelemetry({ waterTempC: 23, waterTempUpdatedAt: new Date().toISOString() });
  a.updateTelemetry({ waterTempC: 23, waterTempUpdatedAt: '2026-08-11T00:00:00.000Z' }); // stale
  a.updateTelemetry({});
});

tryCase('Gas heater thermostat with telemetry (real temp + setpoint read-back)', () => {
  const a = new GasHeaterAccessory(fakePlatform, acc(), 'GAS_HEATER', 'Gas Heater');
  a.update(state['GAS_HEATER']);
  a.updateTelemetry({ waterTempC: 23, poolSetTempC: 36, waterTempUpdatedAt: new Date().toISOString() });
});

tryCase('Gas heater thermostat (off + on states)', () => {
  const a = new GasHeaterAccessory(fakePlatform, acc(), 'GAS_HEATER', 'Gas Heater');
  a.update(state['GAS_HEATER']); // OFF in fixture
  const on = JSON.parse(JSON.stringify(state['GAS_HEATER']));
  on.switchStatus = 'ON';
  a.update(on);
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

tryCase('Stepped fan percent labels map 1:1 (real Vi chlorinator)', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'CHLORINATOR', 'Chlorinator Level');
  a.update(state['CHLORINATOR']); // real payload: 0%..100% in 20% steps, at 100%
  a.update(state['CHLORINATOR']);
});

tryCase('Stepped fan with single-level modeList (single-speed pump edge)', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'PUMP_SPEED', 'Pump Speed');
  const bad = JSON.parse(JSON.stringify(state['PUMP_SPEED']));
  bad.modeList = ['On'];
  a.update(bad); // platform normally filters this out; accessory must still not throw
});

tryCase('Stepped fan with empty modeList', () => {
  const a = new SteppedFanAccessory(fakePlatform, acc(), 'PUMP_SPEED', 'Pump Speed');
  const bad = JSON.parse(JSON.stringify(state['PUMP_SPEED']));
  delete bad.modeList;
  a.update(bad);
});

tryCase('pH read-only (chemistrySetpoints off removes the slider service)', () => {
  const roPlatform = { ...(fakePlatform as object), cfg: { ...(fakePlatform as { cfg: object }).cfg, chemistrySetpoints: false } } as never;
  const a = new ChemistrySensorAccessory(roPlatform, acc(), 'PH', 'pH Sensor');
  a.update(state['PH']);
});

tryCase('pH thermostat (real range 7.0-7.8, reading above max)', () => {
  const a = new ChemistrySensorAccessory(fakePlatform, acc(), 'PH', 'pH Sensor');
  a.update(state['PH']); // real payload: value 8, setPoint 7.7, range 7-7.8
  a.update(state['PH']);
});

tryCase('ORP thermostat (real range 550-750) + blank reading + missing range', () => {
  const a = new ChemistrySensorAccessory(fakePlatform, acc(), 'ORP', 'ORP Sensor');
  a.update(state['ORP']); // real payload: value 680, setPoint 680, range 550-750
  const blank = JSON.parse(JSON.stringify(state['ORP']));
  blank.temperatureSensorStatus = {};
  blank.thermostatStatus = {};
  a.update(blank); // no reading/range — fallbacks, no throw
  a.update(state['ORP']); // range returns — re-clamp before setProps, no throw
});

console.log('');
const specProblems = checkAppleRanges();
if (specProblems.length) {
  failures += specProblems.length;
  console.error(`  \u2717 ${specProblems.length} Apple-spec range violation(s) — these make Apple clients reject the whole bridge:`);
  for (const p of specProblems) console.error(`      ${p}`);
}
if (hapWarnings.length) {
  failures += hapWarnings.length;
  console.error(`  ✗ ${hapWarnings.length} HAP characteristic warning(s) — these spam user logs and indicate ordering bugs:`);
  for (const w of hapWarnings) console.error(`      ${w}`);
}
if (failures) {
  console.error(`SMOKE FAILED — ${failures} accessory case(s) threw under real HAP validation.`);
  process.exit(1);
}
console.log('SMOKE PASSED — all accessories construct and update cleanly under real hap-nodejs validation.');
