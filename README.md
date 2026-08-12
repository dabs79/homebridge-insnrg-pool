# homebridge-insnrg-pool

Homebridge plugin for **INSNRG (Vi / Hub) pool equipment**, bridging the INSNRG **cloud** API into Apple HomeKit: pool/spa heating, spa mode, filter mode, outlets, valves, heat-pump/gas contacts, pool light (with colour modes), pump speed, chlorinator level, and pH/ORP readouts.

The API layer is a faithful TypeScript port of the working Home Assistant integration [jaringuyen/InsnrgHomeAssistance](https://github.com/jaringuyen/InsnrgHomeAssistance), verified request-for-request against the actual Python reference (`npm run verify`).

> **Cloud, not local.** Your INSNRG controller talks to INSNRG's cloud; this plugin authenticates to that cloud with your **insnrgapp.com email + password**. There is no LAN connection, so state changes made at the console can take up to one poll interval to appear in HomeKit, and the plugin needs internet access.

## Supported equipment

Developed and tested against this INSNRG stack (per the official IO manuals):

| Equipment | Models | How it appears in HomeKit |
|---|---|---|
| Vi Automation & Chlorination System | Vi 25, Vi 40 | The brain: source of all outlets (3× 240V), valves (3× actuators), timers, chlorinator level, pH/ORP |
| inTouch Portal | — | Required — the Wi-Fi bridge that connects the Vi to the INSNRG cloud API |
| Si Single Speed Pump | Si 200 / 300 / 400 / 500 | On/off via the **Filter Mode** switch (runs pump + chlorinator). No speed slider — the Vi only offers speed selection with a Qi variable-speed pump on the data cable, and the plugin skips the slider when fewer than 2 levels are reported. |
| Qi Variable Speed Pump | (untested) | Should appear as the stepped Pump Speed fan slider |
| Gi Gas Heater | Gi 160 / 265 / 420 | On/off via the VF-contact switch (`VF_CONTACT_1`, usually named "Gas"); water temperature setpoint via the Pool/Spa Thermostat |
| inTouch Expansion (Relay Hub) | (untested) | Extra `OUTLET_HUB_x` / `VALVE_HUB_x` / `VF_CONTACT_HUB_x` switches |
| Mi Sand Filter | Mi 250 / 320 / 350 / 400 | Not bridged — passive equipment; backwash is a manual multiport-valve operation |

Other configurations (heat pumps on the VF contact, Vi-connected lights, spa combos) follow the same device keys and should work; see `docs/DEVICE_REPORT.md` to contribute a tested-system report.

## Prerequisites

- An account at [insnrgapp.com](https://www.insnrgapp.com) with your system linked.
- **Voice Control enabled** in the INSNRG app under *Connected Systems* (this is what activates the 3rd-party API).

## HomeKit mapping

| INSNRG device | HomeKit accessory | Notes |
|---|---|---|
| Pool / Spa heating (`POOL_CONTROL`, `SPA_CONTROL`) | Thermostat | Heat-only. The API exposes only a target temperature — heater on/off lives on the Heat Pump / Gas contact switch. "Currently heating" is inferred from water temp vs setpoint. |
| Spa mode, Filter mode, All Auto | Switch | |
| Vi/Hub outlets (waterfall, jets, blower…) | Switch | Optional second "Timer" switch = run on schedule |
| Vi/Hub valves | Switch | Optional "Timer" switch as above |
| VF contacts (Heat Pump, Gas) | Switch | Optional "Timer" switch as above |
| Schedule timers 1–4 | Switch | Off by default (`exposeTimers`) |
| Pool light | Lightbulb | Colour modes optionally as one switch per mode (`exposeLightModes`) |
| Pump speed | Fan | Stepped slider — e.g. 3 levels = 33% / 67% / 100% |
| Chlorinator level | Fan | Stepped slider over the reported levels |
| pH | Temperature sensor | **Workaround**: HomeKit has no pH type; the "°C" reading *is* the pH |
| ORP | Light sensor | **Workaround**: the "lux" reading *is* the ORP in mV |

**Pool vs spa temperature commands:** the set-temperature path was reverse-engineered from a single-body-of-water system (pool with spa jets, no separate spa circuit), so only the `_POOL` command variants are capture-verified. The `_SPA` variants exist in the client by naming pattern only — if you have a true pool/spa combo, capture the web app's requests when setting the SPA temperature (DevTools → Network → `send`) and open an issue so they can be verified.

pH/ORP **setpoints** are intentionally read-only for now (adjust them in the INSNRG app); the `setChemistry` command is already ported and verified if we want writable setpoints later.

## Install (local, unpublished)

```powershell
cd C:\homebridge-plugins\homebridge-insnrg-pool
npm install
npm run build
npm install -g .
```

Then restart Homebridge and add the **InsnrgPool** platform via the Homebridge UI, or in `config.json`:

```json
{
  "platform": "InsnrgPool",
  "name": "INSNRG Pool",
  "email": "you@example.com",
  "password": "your-insnrgapp-password",
  "pollIntervalSeconds": 300
}
```

## Pairing the child bridge (and troubleshooting)

Run this plugin as a **child bridge** (Homebridge UI → plugin → Bridge Settings). A child bridge is its own HomeKit accessory and must be paired separately: Bridge Settings shows its QR/setup code; in the Home app use **Add Accessory → More options** if scanning doesn't offer it.

- **Child bridge doesn't appear under "More options":** its HomeKit identity is probably duplicated or stale (e.g. it came up sharing an identity with the main bridge). In Bridge Settings, **reset/re-generate the child bridge** so it gets a unique username + pairing code, restart, and it will advertise fresh.
- **Paired but all accessories "Not responding":** check the child bridge's log first — a crashing bridge looks exactly like this. If the log is healthy: **pin a fixed port** in Bridge Settings (child bridges otherwise pick a random port each restart, which upsets iOS caches and port-scoped firewalls), confirm Windows Firewall allows Node.js on Private networks, try switching the mDNS advertiser (Settings → Network → Ciao ↔ Bonjour HAP), and reboot your iPhone and Home hub (Apple TV/HomePod — ongoing control flows through the hub, so it must reach the Homebridge machine too). As a last resort remove the bridge from the Home app and re-pair once with the port pinned.

## Config options

| Option | Default | Meaning |
|---|---|---|
| `email` / `password` | — | insnrgapp.com credentials |
| `pollIntervalSeconds` | 300 | Cloud refresh interval (min 60). HA reference uses 900. |
| `setpointMin` / `setpointMax` | 10 / 40 | Thermostat fallback range if the cloud reports an implausible one |
| `exposeTimerSwitches` | false | Per-device "Timer" (schedule) switches |
| `exposeTimers` | false | The 4 schedule-timer enable switches |
| `exposeLightModes` | false | One switch per light colour mode |
| `exposeChemistrySensors` | true | pH / ORP readouts |
| `exposeChlorinator` | true | Chlorinator level fan |
| `debug` | false | Log raw `getall` JSON each poll (for remote diagnosis) |

## Behaviour notes

- Every command performs a fresh cloud login first — that's the reference implementation's behaviour, ported as-is.
- After any command the plugin waits 3 seconds and refreshes (also ported from the reference).
- Cloud polls that fail are retried silently; only 3+ consecutive failures log an error.
- Accessories that stop being reported (or that you disable via flags) are pruned once at startup after the first successful poll.

## Verification

`npm run verify` runs two stages:
1. **Protocol** — drives the *verbatim* Python reference (`verify/refpkg/call_api.py`) with a recording mock and asserts my TS client issues byte-identical HTTP requests (URLs, auth headers including the reference's raw-token-vs-Bearer quirk, JSON bodies) and parses `getall` into the identical structure.
2. **HAP smoke** — instantiates every accessory against real `hap-nodejs` with fixture and edge-case state (placeholder ranges, blank readings, empty mode lists).
