#!/usr/bin/env bash
# ============================================================================
# summarizer-opencode.sh - REMEMBER_CLAUDE_BIN target for OpenCode hosts
# ============================================================================
#
# DESCRIPTION
#   pipeline/haiku.py builds a `claude -p --output-format json ...` invocation,
#   feeds the prompt on STDIN (deliberately: a session extract can exceed
#   Linux's MAX_ARG_STRLEN, see pipeline/haiku.py), and parses stdout as
#   Claude's JSON result format. OpenCode has no `-p` mode and none of those
#   flags: `opencode run` reads the prompt from stdin, prints the assistant
#   reply on stdout, and needs no flags.
#
#   This shim is what an OpenCode install points REMEMBER_CLAUDE_BIN at. It
#   discards the claude argv, forwards stdin to `opencode run`, and re-emits
#   the reply in the JSON shape haiku.py's parser already accepts
#   ({"type": "result", "result": ..., "usage": ...}). Upstream
#   pipeline/haiku.py is untouched.
#
#   The claude argv is discarded WHOLE, not translated flag-by-flag. Every
#   flag haiku.py passes is claude-specific (--allowedTools, --mcp-config,
#   --setting-sources, ...); OpenCode's equivalent decisions (model, tools)
#   belong in its own config, not in a transcription of another CLI's argv
#   that would go stale on either side's schedule.
#
# ENVIRONMENT
#   REMEMBER_OPENCODE_BIN     opencode executable (default: opencode on PATH)
#   REMEMBER_OPENCODE_MODEL   provider/model to pass as `opencode run -m ...`;
#                             unset leaves the model to OpenCode's config
#   REMEMBER_NESTED_SUMMARIZER (set by haiku.py) - this shim does not re-enter
#                             the plugin, but the OpenCode process it spawns
#                             will load plugins; the upstream hooks and the
#                             OpenCode adapter both no-op when it is set.
#
# EXIT CODES
#   The child's exit code on failure; 0 on success. stderr carries whatever
#   the child printed so haiku.py's failure detail can explain the failure.
#
# DEPENDENCIES
#   python3 - for JSON emission. Already a hard dependency of the pipeline
#   itself (scripts/detect-tools.sh refuses to run without an interpreter).
#
# ============================================================================

set -u

BIN="${REMEMBER_OPENCODE_BIN:-opencode}"

# --- Discard the claude argv ---
# None of it is meaningful to OpenCode; see the header.
while [ "$#" -gt 0 ]; do
    shift
done

_STDIN_FILE=""
_OUT_FILE=""
_ERR_FILE=""
_cleanup() {
    rm -f "$_STDIN_FILE" "$_OUT_FILE" "$_ERR_FILE"
}
trap _cleanup EXIT

_STDIN_FILE=$(mktemp) || exit 1
_OUT_FILE=$(mktemp) || exit 1
_ERR_FILE=$(mktemp) || exit 1

# The prompt stays on stdin, never argv - the same limit haiku.py respects.
cat > "$_STDIN_FILE"

set -- run
if [ -n "${REMEMBER_OPENCODE_MODEL:-}" ]; then
    set -- "$@" -m "$REMEMBER_OPENCODE_MODEL"
fi
set -- "$@" --log-level ERROR --

"$BIN" "$@" < "$_STDIN_FILE" > "$_OUT_FILE" 2> "$_ERR_FILE"
_rc=$?

if [ "$_rc" -ne 0 ]; then
    # haiku.py's failure detail prefers a JSON message on stdout, so the
    # child's stdout goes to OUR stderr first - exactly where subprocess
    # captures it - followed by the child's own stderr.
    cat "$_OUT_FILE" >&2
    cat "$_ERR_FILE" >&2
    exit "$_rc"
fi

# Re-emit in Claude's --output-format json shape. Usage is honest about what
# opencode's default run output does not report: all zeros read as "unknown
# cost", never as "free", in haiku.py's accounting.
REMEMBER_OPENCODE_OUT_FILE="$_OUT_FILE" python3 -c '
import json
import os

path = os.environ["REMEMBER_OPENCODE_OUT_FILE"]
with open(path, encoding="utf-8", errors="replace") as f:
    text = f.read().strip()
print(json.dumps({
    "type": "result",
    "result": text,
    "usage": {"input_tokens": 0, "output_tokens": 0},
}))
' || exit 1

exit 0
