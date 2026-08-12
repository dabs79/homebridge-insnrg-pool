export const PLATFORM_NAME = 'InsnrgPool';
export const PLUGIN_NAME = 'homebridge-insnrg-pool';

export interface InsnrgPlatformConfig {
  platform: string;
  name?: string;
  email?: string;
  password?: string;
  pollIntervalSeconds?: number;   // default 300, min 60 (cloud API — be polite)
  setpointMin?: number;           // sanitiser fallback when device reports implausible range
  setpointMax?: number;           // capped at 38 (Apple HAP TargetTemperature limit)
  exposeTimerSwitches?: boolean;  // extra "Timer" switch per device that supports TimerOn
  exposeTimers?: boolean;         // the 4 schedule-timer enable switches (clutter, default off)
  exposeLightModes?: boolean;     // one switch per light colour mode
  exposeChemistrySensors?: boolean; // pH / ORP readouts (as humidity/light sensors — HomeKit has no pH type)
  chemistrySetpoints?: boolean;   // opt-in pH/ORP setpoint sliders (render as fan tiles; default off — set targets in the inTouch app)
  exposeChlorinator?: boolean;    // chlorinator level as a stepped fan
  heaterAutoPump?: boolean;       // turning the heater on starts the filter pump first (gas ignition needs flow)
  heaterPumpOffDelayMinutes?: number; // 0 (default) = never auto-stop the pump; >0 = stop it N minutes after heater-off (stay past the Gi's ~5-minute heat-purge run-on)
  exposeWaterTempSensor?: boolean; // standalone Pool Temperature tile from the heater's water-temp register
  debug?: boolean;                // dump raw getall JSON to the log each poll
}
