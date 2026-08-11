# Device Report — INSNRG system details

Fill this in once per tested system. It becomes the "Supported equipment" section
of the README and the fixture source for the verification harness.

## System

| Item | Value |
|---|---|
| Automation/chlorinator unit (Vi 25 / Vi 40 / other) | |
| Firmware / app version (inTouch app → settings) | |
| inTouch Expansion (Relay Hub) fitted? | yes / no |
| Heater type + model (heat pump / gas, brand) | |
| Heater wired to VF contact | VF_CONTACT_? |
| Pump model | |
| Pump speed names shown in inTouch app | |
| Light brand + colour mode names | |
| pH/ORP dosing (Vi premium probes) fitted? | yes / no |

## Outlet / valve assignments (your names)

| API key | Assigned to |
|---|---|
| OUTLET_1 | |
| OUTLET_2 | |
| OUTLET_3 | |
| OUTLET_HUB_3..6 | |
| VALVE_1..3 | |
| VALVE_HUB_1..4 | |

## Captures (the ground truth)

1. Run the plugin with `"debug": true`.
2. Paste the startup `Discovered ...` lines here:

```
(paste)
```

3. Paste ONE `[debug] getall raw:` line here (redact the serial if you wish):

```json
(paste)
```

The raw dump is used to update `verify/fixtures.json` so the harness verifies
against real-world payloads, not invented ones.
