import type {
  API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, InsnrgPlatformConfig } from './settings';
import { InsnrgClient } from './insnrg/client';
import { InsnrgDevice, InsnrgStateMap } from './insnrg/parse';
import {
  CLIMATE_KEYS, SWITCH_KEYS, TIMER_KEYS, ON_OFF_ONLY_KEYS, SwitchMode,
} from './insnrg/constants';
import { ThermostatAccessory } from './accessories/thermostatAccessory';
import { SwitchAccessory } from './accessories/switchAccessory';
import { LightAccessory } from './accessories/lightAccessory';
import { SteppedFanAccessory } from './accessories/steppedFanAccessory';
import { ChemistrySensorAccessory } from './accessories/chemistrySensorAccessory';
import { GasHeaterAccessory } from './accessories/gasHeaterAccessory';

export interface InsnrgAccessoryHandler {
  update(device: InsnrgDevice, state: InsnrgStateMap): void;
}

export class InsnrgPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly client: InsnrgClient;
  public readonly cfg: Required<Pick<InsnrgPlatformConfig,
    'pollIntervalSeconds' | 'setpointMin' | 'setpointMax' | 'exposeTimerSwitches' |
    'exposeTimers' | 'exposeLightModes' | 'exposeChemistrySensors' | 'exposeChlorinator' | 'heaterAutoPump' | 'heaterPumpOffDelayMinutes' | 'debug'>>;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, InsnrgAccessoryHandler>();
  private serial = 'UNKNOWN';

  /** System serial from login — the systemId used by the /prod/send gateway. */
  get systemId(): string { return this.serial; }
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private polling = false;
  private prunedOnce = false;
  private consecutiveFailures = 0;
  private readonly skipLogged = new Set<string>();
  private itemsProbeDone = false;
  private lastState?: InsnrgStateMap;
  private pumpOffTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logger,
    public readonly config: InsnrgPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.cfg = {
      pollIntervalSeconds: Math.max(60, config.pollIntervalSeconds ?? 300),
      setpointMin: config.setpointMin ?? 10,
      setpointMax: Math.min(38, config.setpointMax ?? 38),
      exposeTimerSwitches: config.exposeTimerSwitches ?? false,
      exposeTimers: config.exposeTimers ?? false,
      exposeLightModes: config.exposeLightModes ?? false,
      exposeChemistrySensors: config.exposeChemistrySensors ?? true,
      exposeChlorinator: config.exposeChlorinator ?? true,
      heaterAutoPump: config.heaterAutoPump ?? true,
      heaterPumpOffDelayMinutes: Math.max(0, config.heaterPumpOffDelayMinutes ?? 0),
      debug: config.debug ?? false,
    };

    this.client = new InsnrgClient(config.email ?? '', config.password ?? '');

    if (!config.email || !config.password) {
      this.log.error('Missing "email"/"password" in config — set your insnrgapp.com credentials. Plugin idle.');
      return;
    }

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.pumpOffTimer) clearTimeout(this.pumpOffTimer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    // Never re-create an accessory with a UUID we've already been handed back.
    this.cached.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    const creds = await this.client.testCredentials();
    if (creds === false) {
      this.log.error('INSNRG login failed — check email/password (the ones for insnrgapp.com), '
        + 'and that Voice Control is enabled under Connected Systems in the INSNRG app.');
      return;
    }
    this.serial = creds.serial ?? 'DEMO';
    this.log.info(`Logged in to INSNRG cloud. System serial: ${this.serial}`);

    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.cfg.pollIntervalSeconds * 1000);
  }

  /** Ported reference behaviour: after a successful command, wait 3s then refresh. */
  requestRefreshSoon(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.poll(), 3000);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const { state, rawResponse } = await this.client.getAll();
      this.consecutiveFailures = 0;
      if (this.cfg.debug) {
        this.log.info(`[debug] getall raw: ${JSON.stringify(rawResponse)}`);
      }
      this.applyState(state);
      if (this.cfg.debug && !this.itemsProbeDone) {
        this.itemsProbeDone = true;
        try {
          const values = await this.client.fetchSystemValues(this.serial);
          const text = JSON.stringify(values);
          this.log.info(`[debug] items raw (${text.length} chars): ${text.slice(0, 60000)}`);
        } catch (e) {
          this.log.warn(`[debug] items probe failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      this.consecutiveFailures++;
      const msg = e instanceof Error ? e.message : String(e);
      // Cloud APIs hiccup; only warn loudly after repeated failures.
      if (this.consecutiveFailures >= 3) {
        this.log.error(`INSNRG poll failed ${this.consecutiveFailures}x in a row: ${msg}`);
      } else {
        this.log.debug(`INSNRG poll failed (will retry): ${msg}`);
      }
    } finally {
      this.polling = false;
    }
  }

  private uuidFor(key: string): string {
    return this.api.hap.uuid.generate(`insnrg:${this.serial}:${key}`);
  }

  private applyState(state: InsnrgStateMap): void {
    this.lastState = state;
    const desired = new Set<string>();

    for (const [key, device] of Object.entries(state)) {
      const plan = this.planFor(key, device);
      if (!plan) continue;
      const uuid = this.uuidFor(key);
      desired.add(uuid);

      let handler = this.handlers.get(uuid);
      if (!handler) {
        handler = this.createHandler(uuid, key, device, plan);
        if (!handler) continue;
        this.handlers.set(uuid, handler);
      }
      handler.update(device, state);
    }

    // Devices are reported CONDITIONALLY by the cloud (e.g. the chlorinator
    // level only while the cell runs), so absence at startup does NOT mean
    // removed — never auto-prune. Genuinely dead accessories can be removed
    // via the Homebridge UI (Settings → Remove Single Accessory).
    if (!this.prunedOnce) {
      this.prunedOnce = true;
      const unmatched = [...this.cached.entries()]
        .filter(([uuid]) => !desired.has(uuid))
        .map(([, a]) => a.displayName);
      if (unmatched.length) {
        this.log.info(`Cached accessorie(s) not in this poll (kept — may be reported conditionally): ${unmatched.join(', ')}`);
      }
    }
  }

  private planFor(key: string, device: InsnrgDevice):
    | { kind: 'thermostat' | 'switch' | 'light' | 'steppedFan' | 'chemistry' | 'gasHeater' }
    | null {
    if (CLIMATE_KEYS.includes(key)) return { kind: 'thermostat' };
    if (key === 'PH' || key === 'ORP') {
      return this.cfg.exposeChemistrySensors ? { kind: 'chemistry' } : null;
    }
    if (key === 'GAS_HEATER') return { kind: 'gasHeater' };
    if (SWITCH_KEYS.includes(key)) return { kind: 'switch' };
    if (TIMER_KEYS.includes(key)) return this.cfg.exposeTimers ? { kind: 'switch' } : null;
    if (device.type === 'LIGHT') return { kind: 'light' };
    if (key === 'PUMP_SPEED' || key === 'CHLORINATOR') {
      if (key === 'CHLORINATOR' && !this.cfg.exposeChlorinator) return null;
      // Single-speed pumps (e.g. Insnrg Si): the Vi only offers speed selection
      // with a Qi variable-speed pump on the data cable. Fewer than 2 levels
      // means there is nothing to slide — pump on/off is the Filter Mode switch.
      if ((device.modeList?.length ?? 0) < 2) {
        if (!this.skipLogged.has(key)) {
          this.skipLogged.add(key);
          this.log.info(`${key}: fewer than 2 levels reported (${JSON.stringify(device.modeList ?? [])}) — `
            + 'skipping slider. For a single-speed pump, on/off is the "Filter Mode" switch.');
        }
        return null;
      }
      return { kind: 'steppedFan' };
    }
    // LIGHT_MODE pseudo-device is consumed by the light accessory, not exposed on its own.
    if (key === 'LIGHT_MODE') return null;
    // Fallback: the real cloud payload carries a type field on every device
    // (e.g. GAS_HEATER has type SWITCH but is absent from the reference's key
    // lists). Trust the type so new/renamed devices appear automatically.
    if (device.type === 'SWITCH') return { kind: 'switch' };
    if (device.type && !this.skipLogged.has(key)) {
      this.skipLogged.add(key);
      this.log.info(`Unmapped device "${device.name}" (${key}, type ${device.type}) — not exposed. `
        + 'Send a debug dump if it should be.');
    }
    return null;
  }

  private createHandler(
    uuid: string, key: string, device: InsnrgDevice,
    plan: { kind: string },
  ): InsnrgAccessoryHandler | undefined {
    const name = device.name || key;
    let accessory = this.cached.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Discovered ${plan.kind}: ${name} (${key})`);
    }

    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'INSNRG')
      .setCharacteristic(this.Characteristic.Model, device.type ?? key)
      .setCharacteristic(this.Characteristic.SerialNumber, `${this.serial}-${key}`);

    switch (plan.kind) {
      case 'thermostat': return new ThermostatAccessory(this, accessory, key, name);
      case 'gasHeater': return new GasHeaterAccessory(this, accessory, key, name);
      case 'switch': {
        // Timer (TimerOn) support = the device carries a ToggleController in the
        // payload (toggleStatus '' means none — e.g. GAS_HEATER, TIMERS).
        const supportsTimer = !ON_OFF_ONLY_KEYS.has(key) && device.toggleStatus !== '';
        return new SwitchAccessory(this, accessory, key, name, supportsTimer);
      }
      case 'light': return new LightAccessory(this, accessory, key, name);
      case 'steppedFan': return new SteppedFanAccessory(this, accessory, key, name);
      case 'chemistry': return new ChemistrySensorAccessory(this, accessory, key, name);
      default: return undefined;
    }
  }

  /** Shared command wrapper: log, fire, schedule the 3s refresh, surface failures. */
  async sendSwitch(key: string, deviceId: string, mode: SwitchMode): Promise<void> {
    // Gas ignition halts without water flow (Gi manual): when turning the
    // heater on, ALWAYS send Filter Pump ON first. Never gate this on cached
    // poll state — with a multi-minute poll interval the cache can claim the
    // pump is running minutes after a timer stopped it (live-fire bug, v1.6.0):
    // a redundant TurnOn is harmless; a skipped one is a failed ignition.
    if (key === 'GAS_HEATER' && mode === 'ON' && this.cfg.heaterAutoPump) {
      if (this.pumpOffTimer) { clearTimeout(this.pumpOffTimer); this.pumpOffTimer = undefined; }
      const pumpId = this.lastState?.['MODE']?.deviceId ?? 'MODE';
      this.log.info('→ GAS_HEATER on: ensuring Filter Pump is on first (heaterAutoPump)');
      await this.client.turnTheSwitch('ON', pumpId);
    }
    // Optional delayed pump-off after heater-off. Never immediate: the Gi's
    // run-on purges residual heat through the pump for ~5 minutes.
    if (key === 'GAS_HEATER' && mode === 'OFF' && this.cfg.heaterPumpOffDelayMinutes > 0) {
      if (this.pumpOffTimer) clearTimeout(this.pumpOffTimer);
      const delayMin = this.cfg.heaterPumpOffDelayMinutes;
      const pumpId = this.lastState?.['MODE']?.deviceId ?? 'MODE';
      this.log.info(`GAS_HEATER off: Filter Pump will be turned off in ${delayMin} min (heaterPumpOffDelayMinutes; cancelled if heater restarts)`);
      this.pumpOffTimer = setTimeout(() => {
        this.pumpOffTimer = undefined;
        this.log.info('→ MODE: OFF (delayed pump-off after heater shutdown)');
        this.client.turnTheSwitch('OFF', pumpId)
          .then(() => this.requestRefreshSoon())
          .catch((e) => this.log.error(`Delayed pump-off failed: ${e instanceof Error ? e.message : e}`));
      }, delayMin * 60 * 1000);
    }
    this.log.info(`→ ${key}: ${mode} (setDeviceStatus/${mode})`);
    await this.client.turnTheSwitch(mode, deviceId);
    this.requestRefreshSoon();
  }
}
