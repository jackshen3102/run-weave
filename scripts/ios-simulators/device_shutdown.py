"""Shut down a leased simulator before its pool ownership is released."""
import time

from pool import capture, devices, fail


def shutdown_simulator(udid):
    deadline = time.monotonic() + 30
    shutdown_sent = False
    while True:
        device = devices().get(udid)
        if not device or not device.get("isAvailable"):
            fail("cleanup_incomplete", "Simulator is unavailable; keep lease for inspection")
        if device["state"] == "Shutdown":
            return
        if device["state"] == "Booted" and not shutdown_sent:
            capture(["xcrun", "simctl", "shutdown", udid])
            shutdown_sent = True
            continue
        if time.monotonic() >= deadline:
            fail("cleanup_incomplete", "Simulator did not shut down; keep lease for inspection")
        time.sleep(0.2)
