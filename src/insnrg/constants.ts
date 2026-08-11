/** URLs and command mappings, verbatim from the Home Assistant reference. */

export const LOGIN_URL = 'https://4rsb9rvte4.execute-api.us-east-2.amazonaws.com/prod/api/login';
export const CMD_URL = 'https://4rsb9rvte4.execute-api.us-east-2.amazonaws.com/prod/api/cmd';

export type SwitchMode = 'ON' | 'OFF' | 'TIMER';

export const MODE_TO_CMD_TYPE: Record<SwitchMode, string> = {
  ON: 'TurnOn',
  OFF: 'TurnOff',
  TIMER: 'TimerOn',
};

/** Devices whose select options are ON/OFF only (no TIMER) in the reference. */
export const ON_OFF_ONLY_KEYS = new Set([
  'SPA',
  'TIMERS',
  'TIMER_1_STATUS', 'TIMER_2_STATUS', 'TIMER_3_STATUS', 'TIMER_4_STATUS',
  'TIMER_1_CHL', 'TIMER_2_CHL', 'TIMER_3_CHL', 'TIMER_4_CHL',
]);

/** Switch-style device keys the reference's select platform watches (minus pseudo/mode devices). */
export const SWITCH_KEYS = [
  'SPA', 'MODE', 'TIMERS',
  'OUTLET_1', 'OUTLET_2', 'OUTLET_3',
  'OUTLET_HUB_3', 'OUTLET_HUB_4', 'OUTLET_HUB_5', 'OUTLET_HUB_6',
  'VALVE_1', 'VALVE_2', 'VALVE_3',
  'VALVE_HUB_1', 'VALVE_HUB_2', 'VALVE_HUB_3', 'VALVE_HUB_4',
  'VF_CONTACT_1', 'VF_CONTACT_HUB_1', 'VF_CONTACT_HUB_2', 'VF_CONTACT_HUB_3',
];

export const TIMER_KEYS = [
  'TIMER_1_STATUS', 'TIMER_2_STATUS', 'TIMER_3_STATUS', 'TIMER_4_STATUS',
  'TIMER_1_CHL', 'TIMER_2_CHL', 'TIMER_3_CHL', 'TIMER_4_CHL',
];

export const CLIMATE_KEYS = ['SPA_CONTROL', 'POOL_CONTROL'];
export const CHEMISTRY_KEYS = ['PH', 'ORP'];
