# Changelog

All notable changes to homebridge-insnrg-pool. Versions follow [SemVer](https://semver.org).

## 2.3.0 — Publication release
- First npm-published release.
- Node engines aligned to supported LTS versions (>= 20).
- Added LICENSE (MIT), CHANGELOG, npm `files` whitelist.

## 2.2.x
- **2.2.2** docs: recurring "Not responding" — Windows power management and mesh Wi-Fi (Deco) multicast notes.
- **2.2.1** docs: Apple home-hub reboot fix for paired-but-unresponsive accessories.
- **2.2.0** Chemistry read-only by default; pH/ORP setpoint sliders now opt-in (`chemistrySetpoints`).

## 2.1.0
- pH reading moved to a Humidity sensor (pH × 10, e.g. 81% = pH 8.1) — as a temperature sensor it polluted the room's temperature range in the Home app.

## 2.0.0 — Live water temperature
- Decoded the web app's `/prod/items` Modbus register mirror (register map in README): live water temperature (reg 56, half-degrees) and pool setpoint read-back (reg 65056).
- Gas Heater thermostat shows real water temperature; setpoint changes made in the INSNRG app sync into HomeKit.
- New standalone **Pool Temperature** sensor (`exposeWaterTempSensor`) with evidence-based staleness flagging (each register carries `updatedAt`).

## 1.x
- **1.9.0** `/prod/items` probe: capture-verified request; raw debug dump to discover the schema.
- **1.8.0** Explicit primary service on every accessory (fixes "Not Supported" on multi-switch accessories); `heaterPumpOffDelayMinutes` for optional delayed pump-off after heater shutdown.
- **1.7.0** `heaterAutoPump` made unconditional — cached poll state can be minutes stale; gas ignition requires flow.
- **1.6.0** Apple HAP spec compliance: out-of-spec characteristic ranges made Apple clients reject the entire bridge. Chemistry redesigned Apple-safe; all temperature targets capped at 38 °C; smoke harness now fails on any out-of-range props.
- **1.5.x** Gas Heater thermostat: set-temperature via reverse-engineered `/prod/send` gateway (half-degree encoding, verified against DevTools captures). SPA command variants documented as inferred/unverified.
- **1.4.0** Settable pH/ORP via verified `setChemistry`; widen→set→narrow HAP range helper; smoke harness fails on HAP characteristic warnings.
- **1.3.0** `heaterAutoPump` interlock; chlorinator slider maps 1:1 to real percentage levels.
- **1.2.0** Type-driven device mapping (Gas Heater and future devices appear automatically); payload-derived timer support; removed destructive accessory pruning (devices are reported conditionally).
- **1.1.0** Single-speed pump handling; supported-equipment documentation from the official IO manuals.
- **1.0.x** Initial plugin: faithful TypeScript port of the [InsnrgHomeAssistance](https://github.com/jaringuyen/InsnrgHomeAssistance) cloud API, verified request-for-request against the Python reference; switches, timers, chlorinator, chemistry, dynamic platform with accessory caching.
