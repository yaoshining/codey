"""Manage existing providers through Codey's terminal using isolated profiles."""

import io
import json
import os
from pathlib import Path
import runpy
import ssl
import subprocess
import sys
import tempfile
import time
from http.server import ThreadingHTTPServer
from threading import Thread

import pexpect


Gateway = runpy.run_path(str(Path(__file__).with_name("provider.integration.py")))["Gateway"]
LAN_KEY = "synthetic-management-lan-key"
TLS_KEY = "synthetic-management-tls-key"
RENAMED = "NAS-LiteLLM"
PROMPT = r"\x1b\[\?2026l"


def write_json(path, data):
    path.write_text(json.dumps(data) + "\n")
    path.chmod(0o600)


def run(binary):
    with (tempfile.TemporaryDirectory(prefix="codey-provider-management-") as temp,
          ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as lan,
          ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as tls):
        root = Path(temp).resolve()
        home, project = root / "home", root / "project"
        agent = home / ".codey/agent"
        profiles = agent / "custom-providers"
        profiles.mkdir(parents=True)
        project.mkdir()
        cert, key, config = [root / name for name in ("cert.pem", "key.pem", "cert.conf")]
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n"
                          "[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config,
                        "-keyout", key, "-out", cert], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        tls.socket = context.wrap_socket(tls.socket, server_side=True)
        for server in (lan, tls):
            Thread(target=server.serve_forever, daemon=True).start()

        lan_base = f"http://localhost:{lan.server_port}/chat/v1"
        old = {"id": "litellm", "api": "openai-completions", "auth": "key", "key": LAN_KEY,
               "baseUrl": lan_base, "lanHttpApprovedUrl": lan_base, "models": ["lan-model"], "fixtureNote": "Keep"}
        tls_profile = {"id": "local-tls", "displayName": RENAMED, "api": "openai-completions", "auth": "key", "key": TLS_KEY,
                       "baseUrl": f"https://127.0.0.1:{tls.server_port}/chat/v1", "models": ["tls-model"]}
        profile = profiles / "litellm.json"
        saved_tls = profiles / "local-tls.json"
        defaults = agent / "settings.json"
        settings = {"defaultProvider": "litellm", "defaultModel": "lan-model"}
        models, auth = agent / "models.json", agent / "auth.json"
        history = agent / "sessions/--fixture--/history.jsonl"
        history.parent.mkdir(parents=True)
        history.write_text('{"type":"model_change","provider":"litellm","modelId":"lan-model"}\n')
        history_before = history.read_bytes()
        write_json(profile, old)
        write_json(saved_tls, tls_profile)
        write_json(defaults, settings)
        write_json(models, {"providers": {"manual-only": {"apiKey": "synthetic-manual-key"}}})
        write_json(auth, {"login-only": {"type": "api_key", "key": "synthetic-login-key"}})
        protected = {path: path.read_bytes() for path in (models, auth, saved_tls)}
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "TERM": "xterm-256color", "NO_COLOR": "1",
               "PI_SKIP_VERSION_CHECK": "1", "NODE_EXTRA_CA_CERTS": str(cert)}
        transcript = io.StringIO()
        launcher = ["--no-session", "--offline"]

        def terminal(*args):
            terminal = pexpect.spawn(binary, [*launcher, *args], cwd=project, env=env, encoding="utf-8",
                                     timeout=30, dimensions=(45, 165))
            terminal.logfile_read = transcript
            return terminal

        def start(tty):
            tty.expect(PROMPT)
            time.sleep(.8)

        def enter(tty, text="", down=0):
            if text:
                tty.send(text)
                time.sleep(.18)
            for _ in range(down):
                tty.send("\x1b[B")
                time.sleep(.08)
            tty.send("\r")

        def operation(tty, action, label, peer=None):
            enter(tty, "/provider")
            tty.expect_exact("Delete provider")
            enter(tty, down=action)
            tty.expect_exact("Choose saved provider")
            tty.expect_exact(label)
            assert "manual-only" not in tty.before and "login-only" not in tty.before
            if peer:
                tty.expect_exact(peer)
            enter(tty)

        def replace_name(tty, name):
            tty.expect_exact("Display name for litellm")
            tty.send("\x05\x15")
            time.sleep(.15)
            enter(tty, name)

        def quit(tty):
            enter(tty, "/quit")
            tty.expect(pexpect.EOF)

        def read_default():
            saved = json.loads(defaults.read_text())
            return {name: saved.get(name) for name in ("defaultProvider", "defaultModel")}

        def concurrent_rename(name):
            module = (Path(__file__).resolve().parents[1] / "extensions/provider-store.mjs").as_uri()
            resolver = Path(__file__).resolve().parents[2] / "packages/coding-agent/src/experimental/source-resolver.ts"
            script = f"""import {{ providerStore }} from {json.dumps(module)};
            const [home, project, displayName] = process.argv.slice(1);
            const store = providerStore(home, project);
            const entry = store.list().entries.find((entry) => entry.profile.id === "litellm");
            store.renameDisplayName("litellm", entry.revision, displayName);
            """
            subprocess.run(["node", "--import", resolver, "--input-type=module", "-e", script, home, project, name],
                           check=True, cwd=project, env=env, timeout=20)

        with terminal() as tty:
            start(tty)
            operation(tty, 3, "litellm")
            replace_name(tty, "Invalid Name")
            tty.expect_exact("Use a provider name starting with an ASCII letter")
            assert json.loads(profile.read_text()) == old
            operation(tty, 3, "litellm")
            tty.expect_exact("Display name for litellm")
            concurrent_rename("LITELLM")
            tty.send("\x05\x15")
            time.sleep(.15)
            enter(tty, RENAMED)
            tty.expect_exact("changed in another session")
            assert json.loads(profile.read_text()) == {**old, "displayName": "LITELLM"}

            operation(tty, 3, "LITELLM (ID: litellm)")
            replace_name(tty, RENAMED)
            tty.expect_exact(f"Provider display name saved: {RENAMED} (ID: litellm).")
            assert json.loads(profile.read_text()) == {**old, "displayName": RENAMED}
            assert read_default() == settings
            assert sorted(path.name for path in profiles.glob("*.json")) == ["litellm.json", "local-tls.json"]
            enter(tty, "/model")
            tty.expect_exact(f"({RENAMED}/lan-model)")
            tty.send("\x03")
            time.sleep(.25)
            quit(tty)
        assert not Gateway.seen

        for provider, model, token in (("litellm", "lan-model", LAN_KEY), ("local-tls", "tls-model", TLS_KEY)):
            result = subprocess.run([binary, *launcher, "--provider", provider, "--model", model, "-p", "fixture prompt"],
                                    cwd=project, env=env, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0 and "CHAT_OK" in result.stdout and token not in result.stdout + result.stderr, result
            assert Gateway.seen[-1] == ("/chat/v1/chat/completions", f"Bearer {token}", None, model)
        Gateway.seen.clear()
        print("PASS: legacy rename updated the live /model label, refused an invalid label and a stale write, preserved the profile, and used HTTPS and LAN HTTP after restart.", flush=True)

        with terminal("--provider", "litellm", "--model", "lan-model") as tty:
            start(tty)
            operation(tty, 4, f"{RENAMED} (ID: litellm)")
            tty.expect_exact("Select a different current model with /model")
            enter(tty, "/model")
            tty.expect_exact("[local-tls]")
            tty.send("tls-model")
            time.sleep(.25)
            enter(tty)
            tty.expect_exact("Model: tls-model")
            operation(tty, 4, f"{RENAMED} (ID: litellm)")
            tty.expect_exact("Set a different default with /model")
            enter(tty, "/model")
            tty.expect_exact("[local-tls]")
            tty.send("\x13")
            tty.expect_exact("Default model: local-tls/tls-model")
            assert read_default() == {"defaultProvider": "local-tls", "defaultModel": "tls-model"}
            quit(tty)

        with terminal("--provider", "local-tls", "--model", "tls-model",
                      "--models", "local-tls/tls-model,litellm/lan-model") as tty:
            start(tty)
            operation(tty, 4, f"{RENAMED} (ID: litellm)")
            tty.expect_exact("Remove this provider's models from /scoped-models")
            quit(tty)

        with terminal("--provider", "local-tls", "--model", "tls-model") as tty:
            start(tty)
            operation(tty, 4, f"{RENAMED} (ID: litellm)", peer=f"{RENAMED} (ID: local-tls)")
            tty.expect_exact(f"Delete {RENAMED} (ID: litellm)?")
            tty.expect_exact("its saved API key, and its LAN HTTP approval.")
            tty.expect_exact("Delete provider and saved data")
            enter(tty)
            assert profile.exists()

            operation(tty, 4, f"{RENAMED} (ID: litellm)")
            tty.expect_exact("Delete provider and saved data")
            settings_before = defaults.read_bytes()
            write_json(defaults, json.loads(settings_before) | settings)
            enter(tty, down=1)
            tty.expect_exact("Set a different default with /model")
            assert profile.exists()
            defaults.write_bytes(settings_before)

            operation(tty, 4, f"{RENAMED} (ID: litellm)")
            tty.expect_exact("Delete provider and saved data")
            concurrent_rename("LITELLM")
            enter(tty, down=1)
            tty.expect_exact("changed in another session")
            assert json.loads(profile.read_text()) == {**old, "displayName": "LITELLM"}

            operation(tty, 4, "LITELLM (ID: litellm)")
            tty.expect_exact("Delete provider and saved data")
            enter(tty, down=1)
            tty.expect_exact("Custom provider deleted: LITELLM (ID: litellm).")
            assert not profile.exists()
            enter(tty, "/model")
            tty.expect_exact("[local-tls]")
            model_rows = tty.before
            tty.expect(PROMPT)
            assert "[litellm]" not in model_rows + tty.before
            tty.send("\x03")
            time.sleep(.25)
            quit(tty)

        assert not Gateway.seen
        assert history.read_bytes() == history_before
        assert all(path.read_bytes() == content for path, content in protected.items())
        assert json.loads(defaults.read_text())["defaultProvider"] == "local-tls"
        assert all(secret not in transcript.getvalue() for secret in (LAN_KEY, TLS_KEY, "synthetic-login-key"))
        print("PASS: matching display names showed distinct IDs, current, default and scoped models blocked deletion, Cancel kept the file, stale confirmation was rejected, and confirmed deletion removed live models without a request.", flush=True)
        lan.shutdown()
        tls.shutdown()


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).absolute()))
