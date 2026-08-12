import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';
import { setRangeAndValue } from './hapRange';

/**
 * PH / ORP → HomeKit Thermostat, since the cloud models them exactly that way
 * (ThermostatController with setPoint/valueMin/valueMax) and they are settable
 * via the verified setChemistry command.
 *
 *   CurrentTemperature = live reading (pH units, or ORP in mV)
 *   TargetTemperature  = setpoint → setChemistry on change
 *
 * The "°" is cosmetic — HomeKit has no pH/mV characteristic. Ranges come from
 * the device (sanitised, with sane fallbacks). Apple Home renders the pH dial
 * fine; the ORP dial (550–750) works in HAP but its rendering in Apple Home is
 * unverified — Eve renders both correctly.
 */
export class ChemistrySensorAccessory implements InsnrgAccessoryHandler {
  private readonly service: Service;
  private device?: InsnrgDevice;
  private min: number;
  private max: number;
  private readonly stepSize: number;
  private propsApplied = false;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    const isPh = key === 'PH';
    this.min = isPh ? 6.8 : 400;   // fallbacks if the cloud range is implausible
    this.max = isPh ? 8.0 : 800;
    this.stepSize = isPh ? 0.1 : 10;

    // Migrate from the pre-v1.4 read-only sensor services on cached accessories.
    for (const stale of [Service.TemperatureSensor, Service.LightSensor]) {
      const svc = accessory.getService(stale);
      if (svc) accessory.removeService(svc);
    }

    this.service = accessory.getService(Service.Thermostat)
      ?? accessory.addService(Service.Thermostat, name);
    this.service.setCharacteristic(Characteristic.Name, name);

    // Current reading: give the characteristic room for pH units or mV.
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: isPh ? 14 : 1000, minStep: this.stepSize })
      .onGet(() => this.currentReading());

    // Setpoint: pH/ORP ranges are DISJOINT from TargetTemperature's default
    // 10-38, so use widen->set->narrow (setRangeAndValue) to avoid warnings.
    const target = this.service.getCharacteristic(Characteristic.TargetTemperature);
    setRangeAndValue(target, this.min, this.max, this.stepSize, (this.min + this.max) / 2);
    target
      .onGet(() => this.clamp(this.setpoint()))
      .onSet(async (v) => {
        const raw = Number(v);
        const value = this.clamp(Math.round(raw / this.stepSize) * this.stepSize);
        // Avoid float artefacts like 7.400000000000001 in the JSON body.
        const chem = Number(value.toFixed(2));
        this.platform.log.info(`→ ${this.key}: setpoint ${chem} (setChemistry)`);
        await this.platform.client.setChemistry(chem, this.device?.deviceId ?? this.key);
        this.platform.requestRefreshSoon();
      });

    // Dosing runs automatically — modes are not controllable.
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(Characteristic.TargetHeatingCoolingState.AUTO);
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.AUTO] })
      .onGet(() => Characteristic.TargetHeatingCoolingState.AUTO)
      .onSet(() => { /* fixed */ });
    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => Characteristic.CurrentHeatingCoolingState.OFF);
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  private clamp(v: number): number {
    if (!Number.isFinite(v)) return this.min;
    return Math.min(this.max, Math.max(this.min, v));
  }

  private currentReading(): number {
    const raw = this.device?.temperatureSensorStatus?.value;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    if (!Number.isFinite(n as number)) return this.min;
    return Math.min(this.key === 'PH' ? 14 : 1000, Math.max(0, n as number));
  }

  private setpoint(): number {
    const sp = this.device?.thermostatStatus?.setPoint;
    return typeof sp === 'number' ? sp : (this.min + this.max) / 2;
  }

  /** Sanitise the cloud-reported range; fall back on implausible values. */
  private sanitiseRange(): { min: number; max: number } {
    const t = this.device?.thermostatStatus;
    const rMin = t?.valueMin;
    const rMax = t?.valueMax;
    const cap = this.key === 'PH' ? 14 : 1000;
    const plausible = typeof rMin === 'number' && typeof rMax === 'number'
      && Number.isFinite(rMin) && Number.isFinite(rMax)
      && rMax > rMin && rMin >= 0 && rMax <= cap;
    return plausible ? { min: rMin, max: rMax } : { min: this.min, max: this.max };
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;

    const range = this.sanitiseRange();
    if (!this.propsApplied || range.min !== this.min || range.max !== this.max) {
      this.min = range.min;
      this.max = range.max;
      const target = this.service.getCharacteristic(Characteristic.TargetTemperature);
      setRangeAndValue(target, this.min, this.max, this.stepSize, this.setpoint());
      this.propsApplied = true;
    }

    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentReading());
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.clamp(this.setpoint()));
  }
}
