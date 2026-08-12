import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';
import { setRangeAndValue } from './hapRange';
import type { HeaterTelemetry } from '../insnrg/systemValues';

/**
 * GAS_HEATER → HomeKit Thermostat.
 *   Off/Heat        → verified setDeviceStatus path (with heaterAutoPump interlock)
 *   TargetTemp      → web-app-derived setHeaterTemperature (pool), 10-40°C, 0.5° steps
 *   CurrentTemp     → NOT exposed by any known endpoint yet; mirrors the target
 *                     as a documented placeholder until the web app's "items"
 *                     endpoint is captured and ported.
 * The target isn't readable back either, so the last value set via HomeKit is
 * persisted in accessory.context across restarts.
 */
export class GasHeaterAccessory implements InsnrgAccessoryHandler {
  private readonly service: Service;
  private device?: InsnrgDevice;
  private telemetry?: HeaterTelemetry;

  constructor(
    private readonly platform: InsnrgPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;

    // Migrate from the pre-v1.5 plain Switch on cached accessories.
    for (const sub of ['main', 'timer']) {
      const svc = accessory.getServiceById(Service.Switch, sub);
      if (svc) accessory.removeService(svc);
    }

    this.service = accessory.getService(Service.Thermostat)
      ?? accessory.addService(Service.Thermostat, name);
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.setPrimaryService(true);

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() => this.hkTargetState())
      .onSet(async (v) => {
        const on = v === Characteristic.TargetHeatingCoolingState.HEAT;
        await this.platform.sendSwitch(this.key, this.device?.deviceId ?? this.key, on ? 'ON' : 'OFF');
      });

    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.hkCurrentState());

    const target = this.service.getCharacteristic(Characteristic.TargetTemperature);
    // Apple HAP spec caps TargetTemperature at 38 C (the app allows 40; out-of-spec
    // props make Apple clients reject the whole bridge, so we comply).
    setRangeAndValue(target, 10, 38, 0.5, this.storedTarget());
    target
      .onGet(() => this.storedTarget())
      .onSet(async (v) => {
        const temp = Math.min(38, Math.max(10, Math.round(Number(v) * 2) / 2));
        this.accessory.context.heaterTarget = temp;
        this.platform.log.info(`→ ${this.key}: pool set temperature ${temp}°C (GASHEATER_SET_TEMP_POOL/SETTING_SET_POINT_POOL)`);
        await this.platform.client.setHeaterTemperature(temp, 'pool', this.platform.systemId);
        this.platform.requestRefreshSoon();
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 50 })
      .onGet(() => this.currentWaterTemp());

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);
  }

  private storedTarget(): number {
    // Prefer the cloud-reported setpoint (reg 65056); fall back to the last
    // value set via HomeKit, then a sane default.
    const cloud = this.telemetry?.poolSetTempC;
    if (typeof cloud === 'number') return Math.min(38, Math.max(10, cloud));
    const t = this.accessory.context.heaterTarget;
    return typeof t === 'number' && t >= 10 && t <= 38 ? t : 28;
  }

  private currentWaterTemp(): number {
    const t = this.telemetry?.waterTempC;
    if (typeof t === 'number') return Math.min(50, Math.max(0, t));
    return this.storedTarget(); // no reading yet — mirror target rather than show 0
  }

  updateTelemetry(t: HeaterTelemetry): void {
    this.telemetry = t;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentWaterTemp());
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.storedTarget());
  }

  private hkTargetState(): number {
    const { Characteristic } = this.platform;
    return this.device?.switchStatus === 'ON'
      ? Characteristic.TargetHeatingCoolingState.HEAT
      : Characteristic.TargetHeatingCoolingState.OFF;
  }

  private hkCurrentState(): number {
    const { Characteristic } = this.platform;
    return this.device?.switchStatus === 'ON'
      ? Characteristic.CurrentHeatingCoolingState.HEAT
      : Characteristic.CurrentHeatingCoolingState.OFF;
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.hkTargetState());
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.hkCurrentState());
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.storedTarget());
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentWaterTemp());
  }
}
