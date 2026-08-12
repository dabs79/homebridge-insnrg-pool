/**
 * Pure INSNRG cloud API client.
 *
 * This is a faithful port of call_api.py from
 * https://github.com/jaringuyen/InsnrgHomeAssistance — the only known working
 * reference for the INSNRG 3rd-party REST API. Request URLs, headers and JSON
 * bodies are reproduced exactly and verified request-for-request against the
 * Python reference by `npm run verify`.
 *
 * Deliberate quirks preserved from the reference:
 *  - Every operation performs a fresh login first (the reference never caches
 *    the idToken).
 *  - `getall` sends the raw idToken in the Authorization header; all set
 *    commands send `Bearer <idToken>`. Inconsistent, but it is what the
 *    working reference does.
 *
 * NO homebridge imports in this directory — keep it unit-testable in isolation.
 */

import { LOGIN_URL, CMD_URL, SEND_URL, ITEMS_URL, MODE_TO_CMD_TYPE, SwitchMode } from './constants';
import { InsnrgStateMap, parseGetAll } from './parse';

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export interface LoginResult {
  idToken: string;
  userId: string;
  serial: string | null; // devices[0].serial, or null when no devices ("DEMO" in the reference)
}

export class InsnrgPoolError extends Error {
  constructor(public readonly statusCode: number, public readonly status: string) {
    super(`INSNRG API error ${statusCode}: ${status}`);
  }
}

export class InsnrgClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly userName: string,
    private readonly password: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
  }

  private async post(url: string, headers: Record<string, string>, body: unknown): Promise<FetchResponseLike> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /** Port of the login step embedded in every reference method. */
  private async login(): Promise<{ idToken: string; userId: string; raw: Record<string, unknown> }> {
    const resp = await this.post(LOGIN_URL, {}, {
      userName: this.userName,
      password: this.password,
    });
    if (resp.status !== 200) {
      throw new InsnrgPoolError(resp.status, 'Login failed.');
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const auth = data['auth'] as Record<string, unknown> | undefined;
    const user = data['user'] as Record<string, unknown> | undefined;
    const idToken = auth?.['idToken'] as string | undefined;
    if (idToken === null || idToken === undefined) {
      throw new InsnrgPoolError(200, 'Login returned no idToken (bad credentials?).');
    }
    return { idToken, userId: String(user?.['userId'] ?? ''), raw: data };
  }

  /** Port of test_insnrg_pool_credentials(): validates credentials, returns system serial. */
  async testCredentials(): Promise<LoginResult | false> {
    let login;
    try {
      login = await this.login();
    } catch {
      return false;
    }
    const resp = login.raw;
    const devices = (resp['devices'] as Array<Record<string, unknown>> | undefined) ?? [];
    const serial = devices.length > 0 ? String(devices[0]['serial']) : null;
    return { idToken: login.idToken, userId: login.userId, serial };
  }

  /** Port of get_insnrg_pool_data(): login, getall, parse into the reference's result_dict shape. */
  async getAll(): Promise<{ state: InsnrgStateMap; rawResponse: unknown }> {
    const login = await this.login();
    const resp = await this.post(
      CMD_URL,
      // Reference quirk: getall uses the RAW idToken, no "Bearer " prefix.
      { Authorization: login.idToken },
      { cmd: 'getall', userId: login.userId },
    );
    if (resp.status !== 200) {
      throw new InsnrgPoolError(resp.status, 'Server error.');
    }
    const discoverData = await resp.json();
    return { state: parseGetAll(discoverData as Array<Record<string, unknown>>), rawResponse: discoverData };
  }

  /** Port of turn_the_switch(): mode is 'ON' | 'OFF' | 'TIMER'. */
  async turnTheSwitch(mode: SwitchMode, deviceId: string): Promise<void> {
    const login = await this.login();
    await this.sendCmd(login, {
      cmd: 'setDeviceStatus',
      cmdType: MODE_TO_CMD_TYPE[mode],
      deviceId,
      userId: login.userId,
    }, 'Failed to turn the switch');
  }

  /** Port of set_thermostat_temp(). */
  async setThermostatTemp(tempValue: number, deviceId: string): Promise<void> {
    const login = await this.login();
    await this.sendCmd(login, {
      cmd: 'setTemperature',
      tempValue,
      deviceId,
      userId: login.userId,
    }, 'Failed to set temperature');
  }

  /** Port of set_chemistry(). */
  async setChemistry(chemValue: number, deviceId: string): Promise<void> {
    const login = await this.login();
    await this.sendCmd(login, {
      cmd: 'setChemistry',
      chemValue,
      deviceId,
      userId: login.userId,
    }, 'Failed to set chemistry');
  }

  /** Port of change_light_mode(). deviceId here is the LIGHT device's real id (supportCmd). */
  async changeLightMode(mode: string, deviceId: string): Promise<void> {
    const login = await this.login();
    await this.sendCmd(login, {
      cmd: 'setLightMode',
      lightValue: mode,
      deviceId,
      userId: login.userId,
    }, 'Failed to set light mode');
  }

  /** Port of set_pump_value() — used for both PUMP_SPEED and CHLORINATOR levels. */
  async setPumpValue(mode: string, deviceId: string): Promise<void> {
    const login = await this.login();
    await this.sendCmd(login, {
      cmd: 'setPumpValue',
      pumpValue: mode,
      deviceId,
      userId: login.userId,
    }, 'Failed to set pump value');
  }

  /**
   * Set the gas heater water temperature (pool or spa).
   *
   * NOT part of the HA reference — reverse-engineered from insnrgapp.com web
   * app captures (DevTools, 2026-08-12) and verified against them by the
   * harness. The web app fires TWO commands per update, mirrored here:
   *   1. deviceType gas_heater,  cmd GASHEATER_SET_TEMP_<POOL|SPA>
   *   2. deviceType chlorinator, cmd SETTING_SET_POINT_<POOL|SPA>
   * Encoding: valArgument = [round(tempC * 2)]  (half-degree integers;
   * 32->64, 34->68, 36->72 in the captures).
   *
   * VERIFICATION BOUNDARY: only the POOL variants were captured (the source
   * system is a single body of water — pool with jets, no separate spa). The
   * SPA command strings are pattern-inferred and UNVERIFIED; capture them from
   * a real pool/spa combo before trusting them.
   *
   * The Authorization header format on this gateway is unconfirmed: we try the
   * raw idToken first (matching the getall quirk) and fall back to Bearer.
   */
  async setHeaterTemperature(tempC: number, mode: 'pool' | 'spa', systemId: string): Promise<void> {
    const login = await this.login();
    const val = Math.round(tempC * 2);
    const suffix = mode.toUpperCase();
    const bodies = [
      { systemId, deviceType: 'gas_heater', payloads: [{ cmd: `GASHEATER_SET_TEMP_${suffix}`, valArgument: [val] }] },
      { systemId, deviceType: 'chlorinator', payloads: [{ cmd: `SETTING_SET_POINT_${suffix}`, valArgument: [val] }] },
    ];
    for (const body of bodies) {
      let resp = await this.post(SEND_URL, { Authorization: login.idToken }, body);
      if (resp.status === 401 || resp.status === 403) {
        resp = await this.post(SEND_URL, { Authorization: `Bearer ${login.idToken}` }, body);
      }
      if (resp.status !== 200) {
        throw new InsnrgPoolError(resp.status, `Failed to send ${body.payloads[0].cmd}`);
      }
    }
  }

  /**
   * Fetch the web app's "system values" (captured 2026-08-12: the query the
   * insnrgapp.com dashboard runs to show live values incl. water temperature).
   * Body reproduced verbatim from the capture; response shape is NOT yet
   * known, so this returns the raw JSON — used as a debug probe until the
   * shape is confirmed and parsing can be written from evidence.
   */
  async fetchSystemValues(systemId: string): Promise<unknown> {
    const login = await this.login();
    const body = {
      systemId,
      index: 'getSystemValuesBySystemIdByIsLive',
      isLive: 0,
      operator: 'gt',
    };
    let resp = await this.post(ITEMS_URL, { Authorization: login.idToken }, body);
    if (resp.status === 401 || resp.status === 403) {
      resp = await this.post(ITEMS_URL, { Authorization: `Bearer ${login.idToken}` }, body);
    }
    if (resp.status !== 200) {
      throw new InsnrgPoolError(resp.status, 'Failed to fetch system values');
    }
    return resp.json();
  }

  private async sendCmd(
    login: { idToken: string },
    body: Record<string, unknown>,
    failMessage: string,
  ): Promise<void> {
    const resp = await this.post(
      CMD_URL,
      // Reference quirk: set commands DO use the "Bearer " prefix.
      { Authorization: `Bearer ${login.idToken}` },
      body,
    );
    if (resp.status !== 200) {
      throw new InsnrgPoolError(resp.status, failMessage);
    }
  }
}
