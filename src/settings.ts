export const PLATFORM_NAME = 'InsnrgPool';
export const PLUGIN_NAME = 'homebridge-insnrg-pool';

export interface InsnrgPlatformConfig {
  platform: string;
  name?: string;
  email?: string;
  password?: string;
  pollIntervalSeconds?: number;   // default 300, min 60 (cloud API — be polite)
  setpointMin?: number;           // sanitiser fallback when device reports implausible range
  setpointMax?: number;
  exposeTimerSwitches?: boolean;  // extra "Timer" switch per device that supports TimerOn
  exposeTimers?: boolean;         // the 4 schedule-timer enable switches (clutter, default off)
  exposeLightModes?: boolean;     // one switch per light colour mode
  exposeChemistrySensors?: boolean; // pH / ORP readouts (as temp/light sensors — HomeKit has no pH type)
  exposeChlorinator?: boolean;    // chlorinator level as a stepped fan
  heaterAutoPump?: boolean;       // turning the heater on starts the filter pump first (gas ignition needs flow)
  debug?: boolean;                // dump raw getall JSON to the log each poll
}
