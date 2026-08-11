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

export interface InsnrgAccessoryHandler {
  update(device: InsnrgDevice, state: InsnrgStateMap): void;
}

export class InsnrgPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly client: InsnrgClient;
  public readonly cfg: Required<Pick<InsnrgPlatformConfig,
    'pollIntervalSeconds' | 'setpointMin' | 'setpointMax' | 'exposeTimerSwitches' |
    'exposeTimers' | 'exposeLightModes' | 'exposeChemistrySensors' | 'exposeChlorinator' | 'debug'>>;

  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, InsnrgAccessoryHandler>();
  private serial = 'UNKNOWN';
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private polling = false;
  private prunedOnce = false;
  private consecutiveFailures = 0;

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
      setpointMax: config.setpointMax ?? 40,
      exposeTimerSwitches: config.exposeTimerSwitches ?? false,
      exposeTimers: config.exposeTimers ?? false,
      exposeLightModes: config.exposeLightModes ?? false,
      exposeChemistrySensors: config.exposeChemistrySensors ?? true,
      exposeChlorinator: config.exposeChlorinator ?? true,
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

    // One-shot prune: after the first successful poll, drop cached accessories
    // that no longer map to anything (device removed or feature flag disabled).
    if (!this.prunedOnce) {
      this.prunedOnce = true;
      const stale: PlatformAccessory[] = [];
      for (const [uuid, acc] of this.cached) {
        if (!desired.has(uuid)) stale.push(acc);
      }
      if (stale.length) {
        this.log.info(`Removing ${stale.length} stale accessorie(s): ${stale.map(a => a.displayName).join(', ')}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        for (const a of stale) this.cached.delete(a.UUID);
      }
    }
  }

  private planFor(key: string, device: InsnrgDevice):
    | { kind: 'thermostat' | 'switch' | 'light' | 'steppedFan' | 'chemistry' }
    | null {
    if (CLIMATE_KEYS.includes(key)) return { kind: 'thermostat' };
    if (key === 'PH' || key === 'ORP') {
      return this.cfg.exposeChemistrySensors ? { kind: 'chemistry' } : null;
    }
    if (SWITCH_KEYS.includes(key)) return { kind: 'switch' };
    if (TIMER_KEYS.includes(key)) return this.cfg.exposeTimers ? { kind: 'switch' } : null;
    if (device.type === 'LIGHT') return { kind: 'light' };
    if (key === 'PUMP_SPEED') return { kind: 'steppedFan' };
    if (key === 'CHLORINATOR') return this.cfg.exposeChlorinator ? { kind: 'steppedFan' } : null;
    // LIGHT_MODE pseudo-device is consumed by the light accessory, not exposed on its own.
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
      case 'switch': {
        const supportsTimer = !ON_OFF_ONLY_KEYS.has(key);
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
    this.log.info(`→ ${key}: ${mode} (setDeviceStatus/${mode})`);
    await this.client.turnTheSwitch(mode, deviceId);
    this.requestRefreshSoon();
  }
}
