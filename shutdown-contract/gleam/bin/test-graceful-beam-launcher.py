#!/usr/bin/env python3
"""Black-box tests for the Unix BEAM shutdown launcher using only stdlib."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any

LAUNCHER = Path(__file__).with_name("graceful-beam-launcher")


def parse_events(stderr: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in stderr.splitlines():
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise AssertionError(f"invalid JSON log line: {line!r}") from error
        events.append(value)
    return events


def event_names(events: list[dict[str, Any]]) -> list[str]:
    return [str(event.get("event")) for event in events]


def start_with_tty() -> tuple[subprocess.Popen[str], int]:
    master, slave = os.openpty()
    command = [
        "bash",
        str(LAUNCHER),
        "bash",
        "-c",
        'trap "" TERM; while :; do sleep 1; done',
    ]
    process = subprocess.Popen(
        command,
        stdin=slave,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        close_fds=True,
    )
    os.close(slave)
    return process, master


def finish(process: subprocess.Popen[str], timeout: float = 6.0) -> tuple[int, str]:
    try:
        _, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        _, stderr = process.communicate(timeout=2)
        raise AssertionError(f"launcher did not exit; stderr:\n{stderr}")
    return process.returncode, stderr


def assert_tty_second_sigint() -> None:
    process, master = start_with_tty()
    try:
        time.sleep(0.20)
        os.kill(process.pid, signal.SIGINT)
        time.sleep(0.20)
        os.kill(process.pid, signal.SIGINT)
        _, stderr = finish(process)
    finally:
        os.close(master)

    events = parse_events(stderr)
    names = event_names(events)
    expected = [
        "shutdown_requested",
        "shutdown_force_available",
        "shutdown_forced",
        "shutdown_complete",
    ]
    if names != expected:
        raise AssertionError(f"second-SIGINT events {names!r} != {expected!r}\n{stderr}")
    if events[2].get("trigger") != "sigint" or events[2].get("forced") is not True:
        raise AssertionError(f"second SIGINT did not force: {events[2]!r}")


def assert_tty_eof() -> None:
    process, master = start_with_tty()
    time.sleep(0.20)
    os.kill(process.pid, signal.SIGINT)
    time.sleep(0.20)
    os.close(master)
    _, stderr = finish(process)

    events = parse_events(stderr)
    names = event_names(events)
    expected = [
        "shutdown_requested",
        "shutdown_force_available",
        "shutdown_forced",
        "shutdown_complete",
    ]
    if names != expected:
        raise AssertionError(f"TTY EOF events {names!r} != {expected!r}\n{stderr}")
    if events[2].get("trigger") != "stdin_eof":
        raise AssertionError(f"TTY EOF did not force: {events[2]!r}")


def assert_non_tty_single_sigterm() -> None:
    process = subprocess.Popen(
        [
            "bash",
            str(LAUNCHER),
            "bash",
            "-c",
            'trap "exit 0" TERM; while :; do sleep 1; done',
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(0.20)
    os.kill(process.pid, signal.SIGTERM)
    returncode, stderr = finish(process)
    if returncode != 0:
        raise AssertionError(f"non-TTY graceful exit code {returncode}\n{stderr}")

    events = parse_events(stderr)
    names = event_names(events)
    expected = ["shutdown_requested", "shutdown_complete"]
    if names != expected:
        raise AssertionError(f"non-TTY events {names!r} != {expected!r}\n{stderr}")
    if events[0].get("stdin_is_tty") is not False or events[1].get("forced") is not False:
        raise AssertionError(f"non-TTY contract mismatch: {events!r}")


def main() -> int:
    if not LAUNCHER.is_file():
        raise AssertionError(f"launcher not found: {LAUNCHER}")
    assert_non_tty_single_sigterm()
    assert_tty_second_sigint()
    assert_tty_eof()
    print("BEAM launcher shutdown contract passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
