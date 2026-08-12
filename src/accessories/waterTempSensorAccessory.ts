import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform } from '../platform';
import type { HeaterTelemetry } from '../insnrg/systemValues';

/**
 * Standalone "Pool Temperature" sensor, fed by the gas heater's water-temp
 * register (read only while water flows). StatusActive reflects reading
 * freshness from the record's own updatedAt — stale readings (pump off)
 * stay visible but are flagged inactive.
 */
export class WaterTempSensorAccessory {
  private readonly service: Service;
  private telemetry?: HeaterTelemetry;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.service = accessory.getService(Service.TemperatureSensor)
      ?? accessory.addService(Service.TemperatureSensor, name);
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.setPrimaryService(true);
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 50, minStep: 0.5 })
      .onGet(() => this.temp());
    this.service.getCharacteristic(Characteristic.StatusActive)
      .onGet(() => this.fresh());
  }

  private temp(): number {
    const t = this.telemetry?.waterTempC;
    return typeof t === 'number' ? Math.min(50, Math.max(0, t)) : 0;
  }

  private fresh(): boolean {
    const upd = this.telemetry?.waterTempUpdatedAt;
    if (!upd) return false;
    const age = Date.now() - Date.parse(upd);
    const staleMs = Math.max(15 * 60 * 1000, 2 * this.platform.cfg.pollIntervalSeconds * 1000);
    return Number.isFinite(age) && age >= 0 && age < staleMs;
  }

  updateTelemetry(t: HeaterTelemetry): void {
    this.telemetry = t;
    const { Characteristic } = this.platform;
    if (typeof t.waterTempC === 'number') {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.temp());
    }
    this.service.updateCharacteristic(Characteristic.StatusActive, this.fresh());
  }
}
