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
  private speeds: number[] = [];
  private percent = false;
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

  private step(): number {
    if (!this.modes.length) return 100;
    if (this.percent) {
      const sorted = [...this.speeds].sort((a, b) => a - b);
      let min = 100;
      for (let i = 1; i < sorted.length; i++) min = Math.min(min, sorted[i] - sorted[i - 1]);
      return min > 0 ? min : 100 / this.modes.length;
    }
    return 100 / this.modes.length;
  }

  /** Rebuild the mode→slider-speed mapping. Literal percentage labels
   *  ('0%'…'100%', as the Vi chlorinator reports) map 1:1 onto the slider;
   *  anything else maps evenly by index. */
  private rebuildSpeeds(modes: string[]): void {
    this.modes = modes;
    this.percent = modes.length > 0 && modes.every((m) => /^\d{1,3}\s*%$/.test(m.trim()));
    this.speeds = this.percent
      ? modes.map((m) => Math.min(100, parseInt(m, 10)))
      : modes.map((_, i) => (i + 1) * (100 / modes.length));
  }

  private currentSpeed(): number {
    const idx = this.modes.indexOf(this.device?.modeValue ?? '');
    return idx >= 0 ? this.speeds[idx] : 0;
  }

  private speedToIndex(speed: number): number | null {
    if (!this.modes.length) return null;
    // Non-percent selects have no real "off"; percent selects do ('0%').
    if (!this.percent && speed <= 0) return null;
    let best = 0;
    for (let i = 1; i < this.speeds.length; i++) {
      if (Math.abs(this.speeds[i] - speed) < Math.abs(this.speeds[best] - speed)) best = i;
    }
    return best;
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;

    const modes = device.modeList ?? [];
    if (modes.length && (!this.propsApplied || modes.join('|') !== this.modes.join('|'))) {
      this.rebuildSpeeds(modes);
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
