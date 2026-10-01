"""Read lossless versioned Harbor trace artifacts; legacy raw JSON remains valid."""
import hashlib
import json
import re
from pathlib import Path


def _key(value):
    if (not isinstance(value, dict) or not isinstance(value.get("sessionId"), str)
            or not value["sessionId"] or not isinstance(value.get("id"), str) or not value["id"]
            or not isinstance(value.get("sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["sha256"])):
        raise ValueError("Invalid trace invocation reference")
    return value["sessionId"], value["id"], value["sha256"]


def read_invocation_blobs(directory, *, allow_incomplete_tail=False):
    path = Path(directory) / "trace-invocations.jsonl"
    if not path.exists():
        return {}
    values = {}
    with path.open() as stream:
        for line in stream:
            if not line.endswith("\n"):
                if allow_incomplete_tail:
                    break
                raise ValueError("Incomplete trace invocation blob record")
            value = json.loads(line)
            key = _key(value)
            if value.get("schema") != 1 or not isinstance(value.get("json"), str):
                raise ValueError("Unknown trace invocation blob schema")
            if hashlib.sha256(value["json"].encode()).hexdigest() != value["sha256"]:
                raise ValueError("Trace invocation blob hash mismatch")
            invocation = json.loads(value["json"])
            if invocation.get("id") != value["id"]:
                raise ValueError("Trace invocation blob identity mismatch")
            values[key] = invocation
    return values


def decode_trace_artifact(value, blobs=None):
    if "artifactSchema" not in value:
        return value
    if value["artifactSchema"] != 2:
        raise ValueError("Unknown trace artifact schema")
    blobs = blobs or {}

    def turn(source):
        if "invocations" not in source:
            return source
        invocations = []
        for reference in source["invocations"]:
            key = _key(reference)
            if len(reference) != 3:
                raise ValueError("Invalid trace invocation reference fields")
            if reference["sessionId"] != source["sessionId"]:
                raise ValueError("Trace invocation reference crosses sessions")
            if key not in blobs:
                raise ValueError(f"Missing trace invocation blob: {key}")
            invocations.append(blobs[key])
        return {**source, "invocations": invocations}

    data = value["data"]
    result = {**data, "traces": [turn(item) for item in data["traces"]]}
    if "branches" in data:
        result["branches"] = [{**branch, "turns": [turn(item) for item in branch["turns"]]}
                              for branch in data["branches"]]
    return result


def read_trace_artifact(path):
    path = Path(path)
    value = json.loads(path.read_text())
    if "artifactSchema" not in value:
        return value
    return decode_trace_artifact(value, read_invocation_blobs(path.parent))
