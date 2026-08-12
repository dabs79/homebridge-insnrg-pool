import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';

/**
 * Generic ON/OFF(/TIMER) device → HomeKit Switch.
 * Covers SPA, MODE (filter), TIMERS, outlets, valves, VF contacts, timers.
 *
 * Reference semantics ported from the HA select entity:
 *   switchStatus === 'ON'  → device is ON
 *   toggleStatus === 'ON'  → device is in TIMER (auto/schedule) mode
 *
 * Main Switch:   On = switchStatus === 'ON'; set → TurnOn / TurnOff.
 * Timer Switch (optional, devices that support TimerOn):
 *                On = toggleStatus === 'ON'; on → TimerOn, off → TurnOff.
 */
export class SwitchAccessory implements InsnrgAccessoryHandler {
  private readonly main: Service;
  private readonly timer?: Service;
  private device?: InsnrgDevice;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
    supportsTimer: boolean,
  ) {
    const { Service, Characteristic } = platform;

    this.main = accessory.getServiceById(Service.Switch, 'main')
      ?? accessory.addService(Service.Switch, name, 'main');
    this.main.setCharacteristic(Characteristic.Name, name);
    // Two same-type services without an explicit primary can render as
    // "Not Supported" in the Home app — always mark the main switch primary.
    this.main.setPrimaryService(true);
    this.main.getCharacteristic(Characteristic.On)
      .onGet(() => this.device?.switchStatus === 'ON')
      .onSet(async (v) => {
        await this.platform.sendSwitch(this.key, this.deviceId(), v ? 'ON' : 'OFF');
      });

    const wantTimer = supportsTimer && platform.cfg.exposeTimerSwitches;
    const existingTimer = accessory.getServiceById(Service.Switch, 'timer');
    if (wantTimer) {
      this.timer = existingTimer ?? accessory.addService(Service.Switch, `${name} Timer`, 'timer');
      this.timer.setCharacteristic(Characteristic.Name, `${name} Timer`);
      this.timer.getCharacteristic(Characteristic.On)
        .onGet(() => this.device?.toggleStatus === 'ON')
        .onSet(async (v) => {
          await this.platform.sendSwitch(this.key, this.deviceId(), v ? 'TIMER' : 'OFF');
        });
    } else if (existingTimer) {
      accessory.removeService(existingTimer); // flag turned off since last run
    }
  }

  private deviceId(): string { return this.device?.deviceId ?? this.key; }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;
    this.main.updateCharacteristic(Characteristic.On, device.switchStatus === 'ON');
    this.timer?.updateCharacteristic(Characteristic.On, device.toggleStatus === 'ON');
  }
}
