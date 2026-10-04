"""用途：绑定本机 Codex 的正式 JSONL 及 session 回放，复用 Harbor 完整性读取器。"""
import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "harbor"))
from evidence_index import _Index, _native


def capture(directory, thread_id, identity):
    roots = [Path.home() / ".codex" / "sessions", Path.home() / ".codex" / "archived_sessions"]
    files = []
    for root in roots:
        if root.exists():
            files.extend(root.glob("**/*" + thread_id + "*.jsonl"))
    if len(files) != 1:
        raise ValueError("Exact native Codex session is not uniquely available")
    session = directory / "sessions"
    session.mkdir(mode=0o700)
    shutil.copyfile(files[0], session / files[0].name)
    (session / files[0].name).chmod(0o600)
    shutil.copyfile(directory / "codex.jsonl", directory / "codex.txt")
    (directory / "codex.txt").chmod(0o600)
    index = _Index(directory)
    phase = {"identity": identity, "artifact_ids": []}
    _native(index, directory, phase)
    result = {"phase": phase, "artifacts": index.artifacts, "issues": index.issues}
    if phase.get("native_cli_format", {}).get("state") != "verified" or index.issues:
        result["status"] = "incomplete"
    else:
        result["status"] = "complete"
    path = directory / "evidence-index.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps({"status": result["status"], "nativeFiles": len(phase.get("native_sources", [])), "issues": index.issues}))
    return 0 if result["status"] == "complete" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--thread", required=True)
    parser.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    identities = json.loads(args.identity.read_text())
    identity = next(item for item in identities if item["participantId"] == "codex")
    raise SystemExit(capture(args.directory.resolve(), args.thread, identity))
