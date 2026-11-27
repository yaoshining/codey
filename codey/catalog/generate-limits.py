"""Write the Codey limits snapshot from an exact Models.dev Git revision."""

import argparse
import json
import subprocess
import tomllib


def snapshot(repo, ref):
    def git(*args, input_bytes=None):
        return subprocess.check_output(["git", "-C", repo, *args], input=input_bytes)

    revision = git("rev-parse", "--verify", ref + "^{commit}").decode().strip()
    files = sorted(path for path in git("ls-tree", "-r", "--name-only", "-z", revision + ":models")
                   .decode().split("\0") if path.endswith(".toml"))
    batch = git("cat-file", "--batch", input_bytes="".join(f"{revision}:models/{path}\n" for path in files).encode())
    models = {}
    offset = 0
    for path in files:
        end = batch.index(b"\n", offset)
        _, kind, size = batch[offset:end].split()
        if kind != b"blob":
            raise ValueError(f"Expected a model file at {path}")
        offset = end + 1 + int(size) + 1
        model = tomllib.loads(batch[end + 1:offset - 1].decode())
        modalities = model.get("modalities", {})
        if (model.get("schema") != 2 or model.get("type", "chat") != "chat"
                or "text" not in modalities.get("input", []) or "text" not in modalities.get("output", [])):
            continue
        limits = {}
        for key in ("context", "input", "output"):
            value = model.get("limit", {}).get(key)
            if type(value) is int and 0 < value <= 10_000_000:
                limits[key] = value
        if limits:
            models[path.removesuffix(".toml")] = limits

    print("{")
    print(f'  "revision": "{revision}",')
    print('  "models": {')
    print(",\n".join(f"    {json.dumps(key)}: {json.dumps(value)}" for key, value in models.items()))
    print("  }")
    print("}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository")
    parser.add_argument("revision")
    args = parser.parse_args()
    snapshot(args.repository, args.revision)
