"""Load the adjacent publish.env into the macOS GUI environment at login."""

import subprocess
import sys
from pathlib import Path


KEYS = ("RUNWEAVE_SNAPSHOT_PUBLISH_URL", "RUNWEAVE_SNAPSHOT_PUBLISH_TOKEN")


def load_environment(config):
    values = {}
    for number, line in enumerate(config.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise ValueError(f"publish.env line {number}: expected KEY=VALUE")
        key = key.strip()
        if key in KEYS:
            values[key] = value.strip()

    # An empty configuration remains a no-op; never clear existing GUI values.
    if not values:
        return
    if any(not values.get(key) for key in KEYS):
        raise ValueError("publish.env must contain both non-empty snapshot publish values")
    if any("\0" in value for value in values.values()):
        raise ValueError("publish.env snapshot publish values cannot contain NUL")

    # Finish parsing before any writes. launchctl itself has no batch transaction.
    for key in KEYS:
        try:
            subprocess.run(
                ["/bin/launchctl", "setenv", key, values[key]],
                check=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError:
            # CalledProcessError includes the full command (and token).
            raise RuntimeError(f"launchctl setenv failed for {key}") from None


if __name__ == "__main__":
    try:
        load_environment(Path(__file__).with_name("publish.env"))
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(f"Snapshot environment loading failed: {error}")
