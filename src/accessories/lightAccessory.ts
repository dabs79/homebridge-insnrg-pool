import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice, InsnrgStateMap } from '../insnrg/parse';

/**
 * LIGHT device → HomeKit Lightbulb (on/off via setDeviceStatus).
 *
 * Colour modes come from the LIGHT_MODE pseudo-device (modeList + supportCmd).
 * HomeKit has no "named scene list" characteristic, so when exposeLightModes
 * is on, each mode becomes a Switch on this accessory: turning one on sends
 * setLightMode; the current mode's switch reads as on.
 */
export class LightAccessory implements InsnrgAccessoryHandler {
  private readonly bulb: Service;
  private modeServices = new Map<string, Service>();
  private device?: InsnrgDevice;
  private lightMode?: InsnrgDevice;

  constructor(
    private readonly platform: InsnrgPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.bulb = accessory.getService(Service.Lightbulb)
      ?? accessory.addService(Service.Lightbulb, name);
    this.bulb.setCharacteristic(Characteristic.Name, name);
    this.bulb.setPrimaryService(true);
    this.bulb.getCharacteristic(Characteristic.On)
      .onGet(() => this.device?.switchStatus === 'ON')
      .onSet(async (v) => {
        await this.platform.sendSwitch(this.key, this.device?.deviceId ?? this.key, v ? 'ON' : 'OFF');
      });
  }

  private ensureModeServices(modes: string[]): void {
    if (!this.platform.cfg.exposeLightModes) return;
    const { Service, Characteristic } = this.platform;
    for (const mode of modes) {
      if (this.modeServices.has(mode)) continue;
      const subtype = `mode-${mode}`;
      const svc = this.accessory.getServiceById(Service.Switch, subtype)
        ?? this.accessory.addService(Service.Switch, mode, subtype);
      svc.setCharacteristic(Characteristic.Name, mode);
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.lightMode?.modeValue === mode)
        .onSet(async (v) => {
          if (!v) {
            // A mode can't be "turned off", only replaced — snap back after HomeKit's write.
            setTimeout(() => svc.updateCharacteristic(Characteristic.On, this.lightMode?.modeValue === mode), 500);
            return;
          }
          const target = this.lightMode?.supportCmd ?? this.device?.deviceId ?? this.key;
          this.platform.log.info(`→ ${this.key}: light mode "${mode}"`);
          await this.platform.client.changeLightMode(mode, target);
          this.platform.requestRefreshSoon();
        });
      this.modeServices.set(mode, svc);
    }
  }

  update(device: InsnrgDevice, state: InsnrgStateMap): void {
    this.device = device;
    this.lightMode = state['LIGHT_MODE'];
    const { Characteristic } = this.platform;

    this.bulb.updateCharacteristic(Characteristic.On, device.switchStatus === 'ON');

    const modes = this.lightMode?.modeList ?? device.modeList ?? [];
    this.ensureModeServices(modes);
    for (const [mode, svc] of this.modeServices) {
      svc.updateCharacteristic(Characteristic.On, this.lightMode?.modeValue === mode);
    }
  }
}
