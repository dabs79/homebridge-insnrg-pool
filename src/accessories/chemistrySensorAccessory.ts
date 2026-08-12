import type { PlatformAccessory, Service } from 'homebridge';
import type { InsnrgPlatform, InsnrgAccessoryHandler } from '../platform';
import type { InsnrgDevice } from '../insnrg/parse';

/**
 * PH / ORP → Apple-spec-safe reading + setpoint control.
 *
 * IMPORTANT LESSON (v1.6.0): modelling these as Thermostats with out-of-spec
 * TargetTemperature ranges (pH 7.0-7.8, ORP 550-750 vs Apple's allowed 10-38)
 * made Apple clients reject the ENTIRE bridge — every accessory unresponsive /
 * missing. All characteristic props must stay within Apple's defined ranges.
 *
 * Model now:
 *   Reading:  pH → TemperatureSensor (the "°" value IS the pH; 0-100 spec-ok)
 *             ORP → LightSensor (the "lux" value IS the mV; spec-ok)
 *   Setpoint: a Fan speed slider on the same tile (0-100%, spec-ok):
 *             pH  slider = pH × 10   (77% = pH 7.7)
 *             ORP slider = mV ÷ 10   (68% = 680 mV)
 *             Changes send the verified setChemistry command, clamped to the
 *             device-reported range.
 */
export class ChemistrySensorAccessory implements InsnrgAccessoryHandler {
  private readonly sensor: Service;
  private readonly setter: Service;
  private device?: InsnrgDevice;
  private readonly isPh: boolean;

  constructor(
    private readonly platform: InsnrgPlatform,
    accessory: PlatformAccessory,
    private readonly key: string,
    name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.isPh = key === 'PH';

    // Migrate away from earlier service shapes on cached accessories.
    const staleThermo = accessory.getService(Service.Thermostat);
    if (staleThermo) accessory.removeService(staleThermo);
    if (this.isPh) {
      const staleLux = accessory.getService(Service.LightSensor);
      if (staleLux) accessory.removeService(staleLux);
    } else {
      const staleTemp = accessory.getService(Service.TemperatureSensor);
      if (staleTemp) accessory.removeService(staleTemp);
    }

    if (this.isPh) {
      this.sensor = accessory.getService(Service.TemperatureSensor)
        ?? accessory.addService(Service.TemperatureSensor, name);
      this.sensor.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: 0, maxValue: 14, minStep: 0.1 })
        .onGet(() => this.reading());
    } else {
      this.sensor = accessory.getService(Service.LightSensor)
        ?? accessory.addService(Service.LightSensor, name);
      this.sensor.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
        .setProps({ minValue: 0.0001, maxValue: 2000 })
        .onGet(() => this.reading());
    }
    this.sensor.setCharacteristic(Characteristic.Name, name);

    const setterName = this.isPh ? 'pH Setpoint' : 'ORP Setpoint';
    this.setter = accessory.getServiceById(Service.Fanv2, 'setpoint')
      ?? accessory.addService(Service.Fanv2, setterName, 'setpoint');
    this.setter.setCharacteristic(Characteristic.Name, setterName);
    this.setter.getCharacteristic(Characteristic.Active)
      .onGet(() => Characteristic.Active.ACTIVE)
      .onSet((v) => {
        if (v === Characteristic.Active.INACTIVE) {
          setTimeout(() => this.setter.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE), 500);
        }
      });
    this.setter.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.setpointToSlider(this.setpoint()))
      .onSet(async (v) => {
        const chem = this.clampToDeviceRange(this.sliderToSetpoint(Number(v)));
        this.platform.log.info(`→ ${this.key}: setpoint ${chem} (setChemistry)`);
        await this.platform.client.setChemistry(chem, this.device?.deviceId ?? this.key);
        this.platform.requestRefreshSoon();
      });
  }

  private reading(): number {
    const raw = this.device?.temperatureSensorStatus?.value;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    const fallback = this.isPh ? 7 : 0.0001;
    if (!Number.isFinite(n as number)) return fallback;
    return this.isPh
      ? Math.min(14, Math.max(0, n as number))
      : Math.min(2000, Math.max(0.0001, n as number));
  }

  private setpoint(): number {
    const sp = this.device?.thermostatStatus?.setPoint;
    return typeof sp === 'number' ? sp : (this.isPh ? 7.4 : 680);
  }

  private setpointToSlider(sp: number): number {
    const v = this.isPh ? sp * 10 : sp / 10;
    return Math.min(100, Math.max(0, Math.round(v)));
  }

  private sliderToSetpoint(slider: number): number {
    return this.isPh ? Number((slider / 10).toFixed(1)) : Math.round(slider) * 10;
  }

  private clampToDeviceRange(v: number): number {
    const t = this.device?.thermostatStatus;
    const cap = this.isPh ? 14 : 1000;
    const min = typeof t?.valueMin === 'number' && t.valueMin >= 0 ? t.valueMin : (this.isPh ? 6.8 : 400);
    const max = typeof t?.valueMax === 'number' && t.valueMax <= cap && t.valueMax > min ? t.valueMax : (this.isPh ? 8.0 : 800);
    return Math.min(max, Math.max(min, v));
  }

  update(device: InsnrgDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;
    if (this.isPh) {
      this.sensor.updateCharacteristic(Characteristic.CurrentTemperature, this.reading());
    } else {
      this.sensor.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, this.reading());
    }
    this.setter.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
    this.setter.updateCharacteristic(Characteristic.RotationSpeed, this.setpointToSlider(this.setpoint()));
  }
}
