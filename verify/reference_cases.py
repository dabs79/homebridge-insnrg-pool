#!/usr/bin/env python3
"""Drive the ACTUAL reference implementation (call_api.py copied verbatim from
jaringuyen/InsnrgHomeAssistance) with a fake recording session, and dump every
HTTP request it makes (url, headers, body) plus its parsed getall output as
JSON. verify.ts runs the TS port through the same cases and asserts equality.
"""
import asyncio
import json
import sys
import types
from pathlib import Path

HERE = Path(__file__).parent

# Stub aiohttp so the verbatim reference imports cleanly without the dependency.
aiohttp_stub = types.ModuleType("aiohttp")
class ClientSession:  # noqa: N801 - matches aiohttp name
    pass
aiohttp_stub.ClientSession = ClientSession
sys.modules.setdefault("aiohttp", aiohttp_stub)

sys.path.insert(0, str(HERE))
from refpkg.call_api import InsnrgPool  # noqa: E402

FIXTURES = json.loads((HERE / "fixtures.json").read_text())
LOGIN_RESPONSE = FIXTURES["loginResponse"]
GETALL_RESPONSE = FIXTURES["getallResponse"]


class FakeResp:
    def __init__(self, payload):
        self.status = 200
        self._payload = payload

    async def json(self, content_type=None):
        return self._payload


class RecordingSession:
    def __init__(self):
        self.requests = []

    async def post(self, url, headers=None, json=None):
        body = json
        self.requests.append({
            "url": url,
            "headers": dict(headers) if headers else {},
            "body": body,
        })
        if url.endswith("/api/login"):
            return FakeResp(LOGIN_RESPONSE)
        return FakeResp(GETALL_RESPONSE)


async def main():
    out = {"cases": {}}

    async def run(name, fn):
        session = RecordingSession()
        pool = InsnrgPool(session, "user@example.com", "hunter2")
        result = await fn(pool)
        out["cases"][name] = {"requests": session.requests, "result": result}

    await run("testCredentials", lambda p: p.test_insnrg_pool_credentials())
    await run("getAll", lambda p: p.get_insnrg_pool_data())
    await run("switch_ON", lambda p: p.turn_the_switch("ON", "OUTLET_1"))
    await run("switch_OFF", lambda p: p.turn_the_switch("OFF", "VALVE_HUB_2"))
    await run("switch_TIMER", lambda p: p.turn_the_switch("TIMER", "VF_CONTACT_1"))
    await run("setTemperature", lambda p: p.set_thermostat_temp(28.5, "POOL_CONTROL"))
    await run("setChemistry", lambda p: p.set_chemistry(7.4, "PH"))
    await run("setLightMode", lambda p: p.change_light_mode("Ocean", "LIGHT_1"))
    await run("setPumpValue", lambda p: p.set_pump_value("Medium", "PUMP_SPEED"))

    print(json.dumps(out, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
