import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';
import { setRangeAndValue } from './hapRange';

/**
 * POOL_CONTROL / SPA_CONTROL → HomeKit Thermostat (heat-only).
 *
 * The INSNRG API only exposes a target temperature for these — there is no
 * heater on/off through the thermostat itself (the heat source shows up
 * separately as a VF Contact switch). So TargetHeatingCoolingState is pinned
 * to HEAT and CurrentHeatingCoolingState is derived from current vs target.
 */
export class ThermostatAccessory implements InsnrgAccessoryHandler {
  private readonly service: Service;
  private device?: InsnrgDevice;
  private min: number;
  private max: number;
  private propsApplied = false;

  constructor(
    private readonly platform: InsnrgPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.min = platform.cfg.setpointMin;
    this.max = platform.cfg.setpointMax;

    this.service = accessory.getService(Service.Thermostat)
      ?? accessory.addService(Service.Thermostat, name);
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.setPrimaryService(true);

    const target0 = this.service.getCharacteristic(Characteristic.TargetTemperature);
    setRangeAndValue(target0, this.min, this.max, 0.5, (this.min + this.max) / 2);
    target0
      .onGet(() => this.clamp(this.targetTemp()))
      .onSet(async (v) => {
        const temp = this.clamp(Number(v));
        this.platform.log.info(`→ ${this.key}: set temperature ${temp}°C`);
        await this.platform.client.setThermostatTemp(temp, this.deviceId());
        this.platform.requestRefreshSoon();
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100 })
      .onGet(() => this.currentTemp());

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(Characteristic.TargetHeatingCoolingState.HEAT);
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.HEAT] })
      .onGet(() => Characteristic.TargetHeatingCoolingState.HEAT)
      .onSet(() => { /* heat-only; nothing to send */ });

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.CurrentHeatingCoolingState.OFF,
          Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => this.currentState());

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  private deviceId(): string { return this.device?.deviceId ?? this.key; }

  private clamp(v: number): number {
    if (!Number.isFinite(v)) return this.min;
    return Math.min(this.max, Math.max(this.min, v));
  }

  private targetTemp(): number {
    const t = this.device?.thermostatStatus;
    const raw = t?.ggPoolSetTemperature ?? t?.value;
    return typeof raw === 'number' ? raw : (this.min + this.max) / 2;
  }

  private currentTemp(): number {
    const raw = this.device?.temperatureSensorStatus?.value;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    return Number.isFinite(n as number) ? Math.min(100, Math.max(-50, n as number)) : 0;
  }

  private currentState(): number {
    const { Characteristic } = this.platform;
    return this.currentTemp() < this.targetTemp()
      ? Characteristic.CurrentHeatingCoolingState.HEAT
      : Characteristic.CurrentHeatingCoolingState.OFF;
  }

  /** Sanitise device-reported ranges; fall back to config on implausible values. */
  private sanitiseRange(t?: { valueMin?: number; valueMax?: number }): { min: number; max: number } {
    const fMin = this.platform.cfg.setpointMin;
    const fMax = this.platform.cfg.setpointMax;
    const rMin = t?.valueMin;
    const rMax = t?.valueMax;
    if (typeof rMin !== 'number' || typeof rMax !== 'number'
      || !Number.isFinite(rMin) || !Number.isFinite(rMax) || rMax <= rMin) {
      if (rMin !== undefined || rMax !== undefined) {
        this.platform.log.debug(`${this.key}: implausible device range ${rMin}-${rMax}, using config ${fMin}-${fMax}`);
      }
      return { min: Math.max(10, fMin), max: Math.min(38, fMax) };
    }
    // Clamp a legitimate device range (e.g. 10-40) into Apple's 10-38 window.
    const min = Math.max(10, rMin);
    const max = Math.min(38, rMax);
    return max > min ? { min, max } : { min: Math.max(10, fMin), max: Math.min(38, fMax) };
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;

    const range = this.sanitiseRange(device.thermostatStatus);
    if (!this.propsApplied || range.min !== this.min || range.max !== this.max) {
      this.min = range.min;
      this.max = range.max;
      // Re-clamp current value into the new range BEFORE narrowing props.
      const target = this.service.getCharacteristic(Characteristic.TargetTemperature);
      setRangeAndValue(target, this.min, this.max, 0.5, this.targetTemp());
      this.propsApplied = true;
    }

    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.clamp(this.targetTemp()));
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemp());
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.currentState());
  }
}
