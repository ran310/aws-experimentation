"""
Serves synthesized aws-infra metadata and watches CDK sources to re-run `npm run synth`.
"""
from __future__ import annotations

import json
import logging
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from watchfiles import watch

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
AWS_INFRA = REPO_ROOT / "aws-infra"
GENERATED = AWS_INFRA / "generated"
OVERVIEW_PATH = GENERATED / "stacks-overview.json"
DIAGRAM_PATH = GENERATED / "architecture.mmd"

WATCH_PATHS = (
    AWS_INFRA / "lib",
    AWS_INFRA / "bin",
    AWS_INFRA / "cdk.json",
)

app = FastAPI(title="aws-infra-dashboard API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_synth_lock = threading.Lock()
_last_synth_ok: bool | None = None
_last_synth_at: float | None = None


def run_synth() -> bool:
    global _last_synth_ok, _last_synth_at
    if not AWS_INFRA.is_dir():
        log.error("aws-infra not found at %s", AWS_INFRA)
        return False
    with _synth_lock:
        log.info("Running npm run synth in %s", AWS_INFRA)
        r = subprocess.run(
            ["npm", "run", "synth"],
            cwd=str(AWS_INFRA),
            capture_output=True,
            text=True,
            timeout=600,
        )
        _last_synth_at = time.time()
        _last_synth_ok = r.returncode == 0
        if not _last_synth_ok:
            log.warning("synth failed: %s", (r.stderr or r.stdout)[:2000])
        return _last_synth_ok


def _watch_loop() -> None:
    paths = [p for p in WATCH_PATHS if p.exists()]
    if not paths:
        log.warning("No watch paths exist yet")
        return
    log.info("Watching %s for changes (debounced re-synth)", paths)
    try:
        for _changes in watch(*paths, debounce=1_500, step=500):
            run_synth()
    except Exception:
        log.exception("watch loop error")


@app.on_event("startup")
def startup() -> None:
    if not OVERVIEW_PATH.exists():
        run_synth()
    t = threading.Thread(target=_watch_loop, name="cdk-watch", daemon=True)
    t.start()


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "aws_infra": str(AWS_INFRA),
        "overview_exists": OVERVIEW_PATH.is_file(),
        "last_synth_ok": _last_synth_ok,
        "last_synth_at": _last_synth_at,
    }


@app.post("/api/resynth")
def resynth() -> dict:
    ok = run_synth()
    return {"ok": ok}


@app.get("/api/overview")
def overview() -> dict:
    if not OVERVIEW_PATH.is_file():
        raise HTTPException(
            status_code=404,
            detail="stacks-overview.json missing; run npm run synth in aws-infra",
        )
    return json.loads(OVERVIEW_PATH.read_text(encoding="utf-8"))


@app.get("/api/architecture.mmd", response_class=PlainTextResponse)
def architecture_mmd() -> PlainTextResponse:
    if not DIAGRAM_PATH.is_file():
        raise HTTPException(status_code=404, detail="architecture.mmd missing")
    return PlainTextResponse(
        DIAGRAM_PATH.read_text(encoding="utf-8"),
        media_type="text/plain; charset=utf-8",
    )
