import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';

/**
 * PH / ORP readouts. HomeKit has no pH or millivolt characteristic, so:
 *   PH  → TemperatureSensor whose "°C" value is the pH (0–14 fits the range)
 *   ORP → LightSensor whose "lux" value is the ORP in mV
 * Clearly a workaround — documented in the README. Read-only; setpoints stay
 * in the INSNRG app (the setChemistry command exists in the client if we later
 * want writable setpoints).
 */
export class ChemistrySensorAccessory implements InsnrgAccessoryHandler {
  private readonly service: Service;
  private device?: InsnrgDevice;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    if (key === 'PH') {
      this.service = accessory.getService(Service.TemperatureSensor)
        ?? accessory.addService(Service.TemperatureSensor, name);
      this.service.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: 0, maxValue: 14, minStep: 0.1 })
        .onGet(() => this.value(0, 14, 7));
    } else {
      this.service = accessory.getService(Service.LightSensor)
        ?? accessory.addService(Service.LightSensor, name);
      this.service.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
        .setProps({ minValue: 0.0001, maxValue: 2000 })
        .onGet(() => this.value(0.0001, 2000, 0.0001));
    }
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.getCharacteristic(Characteristic.StatusActive)
      .onGet(() => this.hasReading());
  }

  private hasReading(): boolean {
    const raw = this.device?.temperatureSensorStatus?.value;
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
  }

  private value(min: number, max: number, fallback: number): number {
    const raw = this.device?.temperatureSensorStatus?.value;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (!Number.isFinite(n as number)) return fallback;
    return Math.min(max, Math.max(min, n as number));
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;
    if (this.key === 'PH') {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.value(0, 14, 7));
    } else {
      this.service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, this.value(0.0001, 2000, 0.0001));
    }
    this.service.updateCharacteristic(Characteristic.StatusActive, this.hasReading());
  }
}
