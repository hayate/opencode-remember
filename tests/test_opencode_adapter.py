"""The OpenCode summarizer shim: scripts/summarizer-opencode.sh.

pipeline/haiku.py builds a `claude -p --output-format json ...` invocation,
feeds the prompt on stdin (deliberately: a session extract can exceed
MAX_ARG_STRLEN), and parses stdout as Claude's JSON result format. OpenCode
has no `-p` mode; `opencode run` reads the prompt from stdin, prints the
assistant reply on stdout, and needs none of the claude flags.

The shim is the REMEMBER_CLAUDE_BIN target on OpenCode hosts: it discards the
claude argv, forwards stdin to `opencode run`, and re-emits the reply in the
JSON shape haiku.py's parser already accepts. Upstream pipeline/haiku.py is
untouched.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="bash subprocess + POSIX layout - not portable to Windows runners (#79)",
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SHIM = REPO_ROOT / "scripts" / "summarizer-opencode.sh"

# The exact argv haiku.py builds (pipeline/haiku.py::_build_cmd), pinned here
# so a drift in that list surfaces as a test failure rather than a silent
# host break.
HAIKU_ARGV = [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--model",
    "haiku",
    "--max-turns",
    "1",
    "--allowedTools",
    "Read,Bash",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--setting-sources",
    "",
]

OPENCODE_STUB = """#!/usr/bin/env bash
printf 'argv:%s\\n' "$*" > "$STUB_LOG"
printf 'stdin:' >> "$STUB_LOG"
cat >> "$STUB_LOG"
if [ -n "${STUB_FAIL:-}" ]; then
  printf '%s\\n' "$STUB_FAIL" >&2
  exit "${STUB_FAIL_RC:-3}"
fi
printf '%s\\n' "${STUB_REPLY:-stub reply}"
"""


def _make_stub(tmp_path: Path) -> Path:
    stub = tmp_path / "bin" / "opencode"
    stub.parent.mkdir()
    stub.write_text(OPENCODE_STUB)
    stub.chmod(0o755)
    return stub


def _run_shim(
    tmp_path: Path, *, stdin: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    run_env = dict(os.environ)
    run_env["STUB_LOG"] = str(tmp_path / "stub.log")
    if env:
        run_env.update(env)
    return subprocess.run(
        ["bash", str(SHIM), *HAIKU_ARGV],
        input=stdin,
        capture_output=True,
        text=True,
        env=run_env,
        timeout=60,
    )


def test_shim_runs_opencode_with_stdin_and_rewrites_json(tmp_path):
    stub = _make_stub(tmp_path)
    result = _run_shim(
        tmp_path,
        stdin="summarize this session",
        env={"REMEMBER_OPENCODE_BIN": str(stub), "STUB_REPLY": "session summary"},
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["type"] == "result"
    assert payload["result"] == "session summary"
    assert set(payload.get("usage", {})) == {"input_tokens", "output_tokens"}

    log = (tmp_path / "stub.log").read_text()
    assert log.startswith("argv:run --log-level ERROR --\n"), log
    assert log.endswith("stdin:summarize this session"), log


def test_shim_passes_configured_model_through(tmp_path):
    stub = _make_stub(tmp_path)
    result = _run_shim(
        tmp_path,
        stdin="prompt",
        env={
            "REMEMBER_OPENCODE_BIN": str(stub),
            "REMEMBER_OPENCODE_MODEL": "deepseek/deepseek-chat",
        },
    )
    assert result.returncode == 0, result.stderr
    log = (tmp_path / "stub.log").read_text()
    assert log.startswith(
        "argv:run -m deepseek/deepseek-chat --log-level ERROR --\n"
    ), log


def test_shim_propagates_failure_with_the_childs_stderr(tmp_path):
    stub = _make_stub(tmp_path)
    result = _run_shim(
        tmp_path,
        stdin="prompt",
        env={
            "REMEMBER_OPENCODE_BIN": str(stub),
            "STUB_FAIL": "opencode: provider rate limited",
            "STUB_FAIL_RC": "3",
        },
    )
    assert result.returncode == 3
    assert "provider rate limited" in result.stderr


def test_shim_discards_every_claude_flag(tmp_path):
    """The whole haiku.py argv is claude-specific; none of it may reach
    opencode, which would reject the unknown flags outright."""
    stub = _make_stub(tmp_path)
    result = _run_shim(
        tmp_path, stdin="prompt", env={"REMEMBER_OPENCODE_BIN": str(stub)}
    )
    assert result.returncode == 0, result.stderr
    log = (tmp_path / "stub.log").read_text()
    argv_line = log.splitlines()[0]
    for flag in (
        "-p",
        "--output-format",
        "--max-turns",
        "--allowedTools",
        "--mcp-config",
    ):
        assert flag not in argv_line


class TestOpenCodeSessionIdAccepted:
    def test_save_session_accepts_opencode_shaped_id(self, tmp_path):
        """save-session.sh's id gate requires Claude UUID shape (hex+dashes);
        OpenCode session ids (ses_<base62>) never match it, so every
        session-end flush failed with "invalid session ID". The gate must
        accept the hooks' own stdin allowlist instead, which both hosts'
        ids satisfy."""
        from .test_save_session_gates import _make_env, _run

        sid = "ses_fb32a3f77ffeM5YYMxr6sFUUyc"
        env, project, plugin, _calls, _uuid_sid = _make_env(
            tmp_path, exchanges=0, humans=0
        )
        slug = str(project).replace("/", "-").replace(".", "-").replace("_", "-")
        session_dir = tmp_path / "home" / ".claude" / "projects" / slug
        (session_dir / f"{sid}.jsonl").write_text('{"type":"user"}\n' * 10)

        result = _run(plugin, env, sid, "--force")

        detail = (
            f"rc={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
        )
        assert result.returncode == 0, detail
        assert "invalid session ID" not in result.stdout + result.stderr, detail

    def test_save_session_still_rejects_traversal_ids(self, tmp_path):
        """The gate was loosened from Claude UUID shape to the hooks' own
        allowlist - the negative half must prove traversal ids still fail,
        or a future 'fix' that deletes the check would pass the positive test
        while reopening the transcript-dir escape."""
        from .test_save_session_gates import _make_env, _run

        env, project, plugin, _calls, _uuid_sid = _make_env(
            tmp_path, exchanges=0, humans=0
        )
        # "" is excluded: an empty SESSION_ID is the documented "discover the
        # newest transcript" path (save-session.sh), not an id at all.
        for bad in [".", "..", "a/b", "a\\b", "a b", "a\nb", "a..b", "ses_x;rm"]:
            result = _run(plugin, env, bad, "--force")
            detail = f"id={bad!r} rc={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
            assert result.returncode == 1, detail
            # log() writes to the store's daily log, not the process stdio.
            log_text = "\n".join(
                f.read_text(encoding="utf-8", errors="replace")
                for f in (project / ".remember" / "logs").glob("memory-*.log")
            )
            assert "invalid session ID" in log_text, detail


class TestShimEdgeCases:
    def test_shim_empty_stdin_still_emits_valid_json(self, tmp_path):
        stub = _make_stub(tmp_path)
        result = _run_shim(tmp_path, stdin="", env={"REMEMBER_OPENCODE_BIN": str(stub)})
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["type"] == "result"
        # The stub ignores stdin and always replies; the point is that an
        # empty prompt flows through without breaking the invocation or the
        # JSON re-emit.
        assert payload["result"] == "stub reply"

    def test_shim_missing_binary_fails_loudly(self, tmp_path):
        result = _run_shim(
            tmp_path,
            stdin="prompt",
            env={"REMEMBER_OPENCODE_BIN": str(tmp_path / "no-such-opencode")},
        )
        assert result.returncode != 0
        assert result.stderr.strip(), "a missing binary must not fail silently"

    def test_shim_binary_path_with_spaces(self, tmp_path):
        stub_dir = tmp_path / "bin with space"
        stub_dir.mkdir()
        stub = stub_dir / "opencode"
        stub.write_text(OPENCODE_STUB)
        stub.chmod(0o755)
        result = _run_shim(
            tmp_path,
            stdin="prompt",
            env={"REMEMBER_OPENCODE_BIN": str(stub), "STUB_REPLY": "spaced reply"},
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["result"] == "spaced reply"

    def test_shim_fails_closed_when_stdin_spool_fails(self, tmp_path):
        """A failed stdin spool must abort: proceeding would summarize a
        truncated prompt into the memory layer. Drive it by shadowing `cat`
        on PATH with a failing stub."""
        stub = _make_stub(tmp_path)
        failing_cat = tmp_path / "bin" / "cat"
        failing_cat.write_text("#!/bin/sh\nexit 1\n")
        failing_cat.chmod(0o755)
        env = {
            "REMEMBER_OPENCODE_BIN": str(stub),
            "PATH": f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}",
        }
        result = _run_shim(tmp_path, stdin="prompt", env=env)
        assert result.returncode == 1
        assert "could not spool the prompt from stdin" in result.stderr
        assert not (tmp_path / "stub.log").exists(), "opencode must not be invoked on a failed spool"
