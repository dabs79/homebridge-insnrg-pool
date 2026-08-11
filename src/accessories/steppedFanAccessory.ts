import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';

/**
 * PUMP_SPEED / CHLORINATOR (a named-level select in the API) → Fanv2 with a
 * stepped RotationSpeed slider. modeList[i] maps to speed (i+1) * (100/n).
 *
 * The API has no off command for these, so Active is pinned on; a HomeKit
 * "off" is snapped back after the next state read.
 */
export class SteppedFanAccessory implements InsnrgAccessoryHandler {
  private readonly fan: Service;
  private device?: InsnrgDevice;
  private modes: string[] = [];
  private propsApplied = false;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.fan = accessory.getService(Service.Fanv2)
      ?? accessory.addService(Service.Fanv2, name);
    this.fan.setCharacteristic(Characteristic.Name, name);

    this.fan.getCharacteristic(Characteristic.Active)
      .onGet(() => Characteristic.Active.ACTIVE)
      .onSet((v) => {
        if (v === Characteristic.Active.INACTIVE) {
          this.platform.log.info(`${this.key}: has no OFF — level is set with the slider; reverting.`);
          setTimeout(() => this.fan.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE), 500);
        }
      });

    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .onGet(() => this.currentSpeed())
      .onSet(async (v) => {
        const idx = this.speedToIndex(Number(v));
        if (idx === null) return;
        const mode = this.modes[idx];
        this.platform.log.info(`→ ${this.key}: "${mode}" (setPumpValue)`);
        await this.platform.client.setPumpValue(mode, this.device?.deviceId ?? this.key);
        this.platform.requestRefreshSoon();
      });
  }

  private step(): number { return this.modes.length ? 100 / this.modes.length : 100; }

  private currentSpeed(): number {
    const idx = this.modes.indexOf(this.device?.modeValue ?? '');
    return idx >= 0 ? (idx + 1) * this.step() : 0;
  }

  private speedToIndex(speed: number): number | null {
    if (!this.modes.length) return null;
    if (speed <= 0) return null; // treat slider-to-zero like Active off: no API equivalent
    const idx = Math.min(this.modes.length - 1, Math.max(0, Math.round(speed / this.step()) - 1));
    return idx;
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;

    const modes = device.modeList ?? [];
    if (modes.length && (!this.propsApplied || modes.join('|') !== this.modes.join('|'))) {
      this.modes = modes;
      const rs = this.fan.getCharacteristic(Characteristic.RotationSpeed);
      rs.updateValue(this.currentSpeed()); // valid value before setProps
      rs.setProps({ minValue: 0, maxValue: 100, minStep: this.step() });
      this.propsApplied = true;
      this.platform.log.debug(`${this.key}: levels [${modes.join(', ')}], step ${this.step().toFixed(2)}%`);
    }

    this.fan.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
    this.fan.updateCharacteristic(Characteristic.RotationSpeed, this.currentSpeed());
  }
}
