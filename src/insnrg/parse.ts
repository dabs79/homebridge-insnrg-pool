/**
 * Parser for the `getall` response — an exact port of the result_dict
 * construction inside get_insnrg_pool_data() in the reference call_api.py,
 * including the LIGHT_MODE / PUMP_SPEED / CHLORINATOR pseudo-device entries.
 * Verified against the Python reference by the harness.
 */

export interface ThermostatStatus {
  value?: number;
  valueMin?: number;
  valueMax?: number;
  setPoint?: number;
  ggPoolSetTemperature?: number;
  [k: string]: unknown;
}

export interface InsnrgDevice {
  name: string;
  deviceId: string;
  type?: string;
  supportCmd?: string;
  switchStatus: string; // '' | 'ON' | 'OFF'
  toggleStatus: string; // '' | 'ON' | 'OFF'  (ON = timer mode engaged)
  thermostatStatus: ThermostatStatus;
  temperatureSensorStatus: { value?: number | string; [k: string]: unknown };
  modeValue: string;
  modeList?: string[];
}

export type InsnrgStateMap = Record<string, InsnrgDevice>;

function propValue(status: Array<Record<string, unknown>>, namespace: string, fallback: unknown): unknown {
  const prop = status.find((p) => p['namespace'] === namespace);
  return prop !== undefined ? prop['value'] : fallback;
}

export function parseGetAll(discoverData: Array<Record<string, unknown>>): InsnrgStateMap {
  const resultDict: InsnrgStateMap = {};
  for (const item of discoverData) {
    const deviceId = String(item['deviceId']);
    const status = (item['properties'] as Array<Record<string, unknown>>) ?? [];
    const type = (item['type'] as unknown[])?.[0] as string | undefined;

    resultDict[deviceId] = {
      name: String(item['name']),
      deviceId,
      type,
      switchStatus: propValue(status, 'Alexa.PowerController', '') as string,
      toggleStatus: propValue(status, 'Alexa.ToggleController', '') as string,
      thermostatStatus: propValue(status, 'Alexa.ThermostatController', {}) as ThermostatStatus,
      temperatureSensorStatus: propValue(status, 'Alexa.TemperatureSensor', {}) as { value?: number | string },
      modeValue: propValue(status, 'Alexa.ModeController', '') as string,
    };

    if (type === 'LIGHT') {
      resultDict['LIGHT_MODE'] = {
        name: 'Light Modes',
        deviceId: 'LIGHT_MODE',
        supportCmd: deviceId,
        switchStatus: '',
        toggleStatus: '',
        thermostatStatus: {},
        temperatureSensorStatus: {},
        modeValue: propValue(status, 'Alexa.ModeController', '') as string,
        modeList: item['options'] as string[],
      };
    }
    if (type === 'PUMP_SPEED') {
      resultDict['PUMP_SPEED'] = {
        name: 'Pump Speed',
        deviceId,
        supportCmd: deviceId,
        switchStatus: '',
        toggleStatus: '',
        thermostatStatus: {},
        temperatureSensorStatus: {},
        modeValue: propValue(status, 'Alexa.ModeController', '') as string,
        modeList: item['options'] as string[],
      };
    }
    if (type === 'CHLORINATOR') {
      resultDict['CHLORINATOR'] = {
        name: 'Chlorinator Level',
        deviceId,
        supportCmd: deviceId,
        switchStatus: '',
        toggleStatus: '',
        thermostatStatus: {},
        temperatureSensorStatus: {},
        modeValue: propValue(status, 'Alexa.ModeController', '') as string,
        modeList: item['options'] as string[],
      };
    }
    if ('options' in item) {
      resultDict[deviceId].modeList = item['options'] as string[];
    }
  }
  return resultDict;
}
