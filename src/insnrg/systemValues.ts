/**
 * Parser for the /prod/items "system values" response — a mirror of the
 * system's Modbus registers: [{deviceType, modbusReg, modbusVal, updatedAt,…}].
 *
 * Register map derived from a live capture (2026-08-12), cross-validated
 * against independently-known values:
 *   gas_heater reg 56    = water temperature, half-degrees C  ([46] → 23.0,
 *                          matching the app dashboard; freshest updatedAt)
 *   gas_heater reg 65056 = pool set-temperature, half-degrees C ([72] → 36.0,
 *                          the register our SETTING_SET_POINT_POOL [72] wrote)
 *   (corroboration: chlorinator reg 52 = pH×10 = 81 → 8.1; reg 53 = ORP÷10
 *    = 68 → 680 mV — both matching the getall payload exactly)
 *
 * Every record carries updatedAt — liveness comes from evidence, not from
 * inferring sensor validity from pump state.
 */

export interface HeaterTelemetry {
  waterTempC?: number;
  waterTempUpdatedAt?: string;
  poolSetTempC?: number;
}

interface SystemValueRecord {
  deviceType?: string;
  modbusReg?: number;
  modbusVal?: number[];
  updatedAt?: string;
}

export function extractHeaterTelemetry(raw: unknown): HeaterTelemetry {
  const out: HeaterTelemetry = {};
  const data = (raw as { data?: SystemValueRecord[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const rec of data) {
    if (rec?.deviceType !== 'gas_heater' || !Array.isArray(rec.modbusVal) || rec.modbusVal.length < 1) continue;
    const v = rec.modbusVal[0];
    if (rec.modbusReg === 56 && Number.isFinite(v)) {
      out.waterTempC = v / 2;
      out.waterTempUpdatedAt = rec.updatedAt;
    } else if (rec.modbusReg === 65056 && Number.isFinite(v)) {
      out.poolSetTempC = v / 2;
    }
  }
  return out;
}
