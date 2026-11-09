"""Ephemeral operation state for the local live observer. Never stores UI arguments."""
from contextlib import contextmanager
from functools import wraps
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid


@contextmanager
def observe(owner, args, env=None):
    actions = {"open", "snapshot", "screenshot", "press", "tap", "click", "swipe", "scroll",
               "type", "fill", "back", "home", "wait", "find", "get", "is", "close", "long-press"}
    if Path(args[0]).name != "agent-device" or len(args) < 2 or args[1] not in actions:
        yield
        return
    path = Path.home() / ".runweave" / "agent-device" / "observations" / (owner["udid"] + ".json")
    private = "--private" in sys.argv
    state = {"schemaVersion": 1, "udid": owner["udid"], "lease": owner["lease"],
             "taskDir": owner["taskDir"], "app": owner["app"], "operationId": uuid.uuid4().hex,
             "terminalSessionId": (env or os.environ).get("RUNWEAVE_TERMINAL_SESSION_ID"),
             "action": args[1], "phase": "private" if private else "running"}

    def publish():
        temporary = path.with_suffix("." + state["operationId"] + ".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {**state, "expiresAt": int((time.time() + 6) * 1000)}
            with temporary.open("w") as stream:
                os.chmod(temporary, 0o600)
                json.dump(payload, stream)
            temporary.replace(path)
        except OSError:
            # Observation must never break device ownership or the actual action.
            pass
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    stopped = threading.Event()

    def heartbeat():
        while not stopped.wait(1):
            publish()

    publish()
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join()
        state["phase"] = "private" if private else "settling"
        state["settleUntil"] = int((time.time() + 3) * 1000)
        publish()


def observed(run):
    @wraps(run)
    def wrapper(self, args, **kwargs):
        with observe(self.owner, args, kwargs.get("env")):
            return run(self, args, **kwargs)
    return wrapper
