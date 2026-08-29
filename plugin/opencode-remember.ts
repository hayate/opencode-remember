// opencode-remember: the OpenCode adapter for the remember plugin.
//
// The upstream plugin is a set of shell lifecycle hooks (SessionStart,
// UserPromptSubmit, PostToolUse, SessionEnd) plus a Python pipeline that
// reads a Claude-format JSONL transcript. OpenCode has no shell lifecycle
// hooks, so this adapter does the host-side work, keeping every upstream
// file byte-identical:
//
//   * fires the four upstream hook scripts from OpenCode events
//     (session.created -> SessionStart, message.updated on user messages ->
//     UserPromptSubmit, tool.execute.after -> PostToolUse,
//     session.deleted / dispose -> SessionEnd);
//   * synthesizes the same stdin JSON payloads the hooks read
//     (session_id / transcript_path / cwd / source / reason / tool fields);
//   * maintains a Claude-format JSONL mirror of the OpenCode session under
//     ~/.cache/opencode/remember-mirror, and points CLAUDE_CONFIG_DIR there
//     so the upstream transcript lookups resolve to it unchanged;
//   * feeds the SessionStart memory injection into the session via
//     experimental.chat.system.transform;
//   * points REMEMBER_CLAUDE_BIN at scripts/summarizer-opencode.sh so the
//     background consolidation shells `opencode run` instead of `claude -p`.
//
// The upstream hooks and pipeline are untouched: this file and
// scripts/summarizer-opencode.sh are the whole host-specific surface. The
// event logic lives in core.ts, dependency-injected so node --test can
// drive it without Bun.

import type { Plugin } from "@opencode-ai/plugin"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { mkdir, rename, unlink, writeFile } from "node:fs/promises"

import { createCore, nestedGuardDisabled, type Spawn } from "./core.ts"

function mirrorRootFromEnv(): string {
  const override = (process.env.REMEMBER_OPENCODE_MIRROR ?? "").trim()
  if (override) return override.replace(/\/+$/, "")
  return join(homedir(), ".cache", "opencode", "remember-mirror")
}

export const OpenCodeRemember: Plugin = async ({ client, directory }) => {
  if (nestedGuardDisabled(process.env)) return {}

  const ROOT = dirname(import.meta.dir)
  const MIRROR_ROOT = mirrorRootFromEnv()

  const spawn: Spawn = async (args, opts) => {
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(opts.env ?? {}) },
    })
    proc.stdin.write(opts.stdin ?? "")
    proc.stdin.end()
    // Read both streams concurrently: a hook writing past the stderr pipe
    // buffer while nothing drains it would block the process dead.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { stdout, stderr, exit: proc.exitCode ?? 0 }
  }

  const writeMirror = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true })
    // A unique temp name per write: concurrent refreshes (tool + idle) must
    // not interleave into one shared tmp file; each rename is atomic and
    // last-wins.
    const tmp = `${path}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      await writeFile(tmp, content, "utf-8")
      await rename(tmp, path)
    } finally {
      unlink(tmp).catch(() => {})
    }
  }

  const core = createCore({
    root: ROOT,
    mirrorRoot: MIRROR_ROOT,
    client: client as never,
    spawn,
    writeMirror,
    log: (message) => console.log(message),
    defaultDirectory: directory,
  })

  return {
    "shell.env": async (input, output) => {
      output.env.PLUGIN_ROOT = ROOT
      output.env.CLAUDE_CONFIG_DIR = MIRROR_ROOT
      output.env.CLAUDE_PROJECT_DIR = input.cwd
      output.env.REMEMBER_CLAUDE_BIN = join(ROOT, "scripts", "summarizer-opencode.sh")
    },

    event: async ({ event }) => {
      await core.handleEvent(event)
    },

    "tool.execute.after": async (input, output) => {
      await core.onToolAfter(input, output)
    },

    "experimental.chat.system.transform": async (input, output) => {
      await core.onSystemTransform(input, output)
    },

    dispose: async () => {
      await core.dispose()
    },
  }
}
