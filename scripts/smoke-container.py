"""Exercise the built container and real Postgres without paid providers."""
import json
import os
import time
from http.client import RemoteDisconnected
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

base = os.environ.get("MOOLAI_SMOKE_BASE_URL", "http://127.0.0.1:8000")
for attempt in range(20):
    try:
        with urlopen(base + "/health", timeout=2) as response:
            assert json.load(response)["status"] == "ok"
        break
    except (URLError, RemoteDisconnected):
        if attempt == 19:
            raise
        time.sleep(1)

identifier = "container-smoke-" + str(uuid4())
record = dict(
    id=identifier, kind="dictation", revision=1, sourceRevision=1,
    createdAt="2026-09-20T00:00:00Z", updatedAt="2026-09-20T00:00:00Z",
    segments=[dict(id=identifier + "-segment", turnId=identifier + "-turn", revision=1,
                   speaker="user", text="Container acceptance fixture.", final=True,
                   createdAt="2026-09-20T00:00:00Z")],
    title="Container fixture", summary="", topics=[], quality="pending",
    qualityReasons=[], doubt=False, links=[], attachmentIds=[], manualFields=[], acceptedRevision=0,
)
payload = json.dumps(dict(record=record, operationId=identifier + "-operation")).encode()
for _ in range(2):
    request = Request(base + "/v1/records/accept", data=payload, headers={
        "Authorization": "Bearer ci-fixture-token", "Content-Type": "application/json",
    })
    with urlopen(request, timeout=10) as response:
        assert response.status == 200 and json.load(response) == {"revision": 1}
print("PASS: built container health, Postgres acceptance and idempotent replay; no provider calls")
