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
// scripts/summarizer-opencode.sh are the whole host-specific surface.

import type { Plugin } from "@opencode-ai/plugin"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { mkdir, rename, writeFile } from "node:fs/promises"

import {
  isSafeSessionId,
  mirrorPath,
  postToolPayload,
  serializeMirror,
  sessionEndPayload,
  sessionStartPayload,
  userPromptPayload,
  type OpenCodeMessage,
} from "./lib.ts"

// The nested summarizer guard (#204 upstream): a consolidation run shells
// this very CLI, whose child process would otherwise load this adapter and
// re-enter its own hooks. Same marker upstream haiku.py exports.
const NESTED_GUARD = "REMEMBER_NESTED_SUMMARIZER"

type SessionLike = {
  id: string
  directory: string
}

type SessionState = {
  id: string
  directory: string
  slugPromise: Promise<string>
  slug: string
  transcriptPath: string
  ended: boolean
  injection: Promise<string>
}

type OpenCodeClient = {
  session: {
    messages(options: { path: { id: string } }): Promise<unknown>
    message(options: { path: { id: string; messageID: string } }): Promise<unknown>
  }
}

type MessageAndParts = {
  info?: { id?: string; sessionID?: string; role?: string }
  parts?: OpenCodeMessage["parts"]
}

function mirrorRootFromEnv(): string {
  const override = (process.env.REMEMBER_OPENCODE_MIRROR ?? "").trim()
  if (override) return override.replace(/\/+$/, "")
  return join(homedir(), ".cache", "opencode", "remember-mirror")
}

export const OpenCodeRemember: Plugin = async ({ client, directory, project }) => {
  if (process.env[NESTED_GUARD] === "1") return {}

  const ROOT = dirname(import.meta.dir)
  const MIRROR_ROOT = mirrorRootFromEnv()
  const SCRIPTS = join(ROOT, "scripts")

  const sessions = new Map<string, SessionState>()
  const promptFired = new Set<string>()
  const slugCache = new Map<string, Promise<string>>()

  const slugFor = (dir: string): Promise<string> => {
    let cached = slugCache.get(dir)
    if (!cached) {
      cached = (async () => {
        // Compute the slug with the upstream function itself, so the mirror
        // directory and the hooks can never disagree about the spelling.
        const proc = Bun.spawn(
          ["bash", "-c", 'source "$0/scripts/lib-slug.sh" && session_dir_slug "$1"', ROOT, dir],
          { stdout: "pipe", stderr: "pipe" },
        )
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out.trim() || "-" + dir.replace(/[^a-zA-Z0-9]/g, "-")
      })().catch(() => "-unknown")
      slugCache.set(dir, cached)
    }
    return cached
  }

  const runHook = async (
    script: string,
    stdinJson: string,
    cwd: string,
  ): Promise<{ stdout: string; exit: number }> => {
    const proc = Bun.spawn(["bash", join(SCRIPTS, script)], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PLUGIN_ROOT: ROOT,
        CLAUDE_CONFIG_DIR: MIRROR_ROOT,
        REMEMBER_HOOK_CWD: cwd,
        REMEMBER_CLAUDE_BIN: join(SCRIPTS, "summarizer-opencode.sh"),
      },
    })
    proc.stdin.write(stdinJson)
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { stdout, exit: proc.exitCode ?? 0 }
  }

  const fireHook = (script: string, stdinJson: string, cwd: string) => {
    runHook(script, stdinJson, cwd).catch(() => {
      // Hooks are fire-and-forget from the event loop's point of view: a
      // spawn failure must never surface into opencode's own event handling.
    })
  }

  const refreshMirror = async (state: SessionState) => {
    await state.slugPromise
    if (!state.transcriptPath) return
    const res: unknown = await (client as unknown as OpenCodeClient).session.messages({
      path: { id: state.id },
    })
    const items: MessageAndParts[] = Array.isArray(res)
      ? (res as MessageAndParts[])
      : ((res as { data?: MessageAndParts[] }).data ?? [])
    const messages: OpenCodeMessage[] = []
    for (const item of items) {
      const info = item.info
      if (!info) continue
      const role = info.role === "assistant" ? "assistant" : "user"
      messages.push({
        id: info.id,
        sessionID: info.sessionID,
        role,
        parts: item.parts ?? [],
      })
    }
    const jsonl = serializeMirror(messages, state.id)
    await mkdir(dirname(state.transcriptPath), { recursive: true })
    const tmp = state.transcriptPath + ".tmp"
    await writeFile(tmp, jsonl, "utf-8")
    await rename(tmp, state.transcriptPath)
  }

  const endSession = (state: SessionState, reason: string) => {
    if (state.ended) return
    state.ended = true
    void state.slugPromise
      .then(() => {
        if (!state.transcriptPath) return
        fireHook(
          "session-end-hook.sh",
          sessionEndPayload(state.id, state.transcriptPath, state.directory, reason),
          state.directory,
        )
      })
      .catch(() => {})
  }

  return {
    "shell.env": async (input, output) => {
      output.env.PLUGIN_ROOT = ROOT
      output.env.CLAUDE_CONFIG_DIR = MIRROR_ROOT
      output.env.CLAUDE_PROJECT_DIR = input.cwd
      output.env.REMEMBER_CLAUDE_BIN = join(SCRIPTS, "summarizer-opencode.sh")
    },

    event: async ({ event }) => {
      const props = (event.properties ?? {}) as Record<string, unknown>
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = props.info as SessionLike | undefined
        if (!info?.id || !isSafeSessionId(info.id)) return
        const directory = info.directory || directory
        if (sessions.has(info.id)) return
        // The map entry lands SYNCHRONOUSLY: the first request's
        // system.transform can fire milliseconds after session creation,
        // before the slug resolves, and must still find the state to await.
        const slugPromise = slugFor(directory)
        const state: SessionState = {
          id: info.id,
          directory,
          slugPromise,
          slug: "",
          transcriptPath: "",
          ended: false,
          injection: Promise.resolve(""),
        }
        state.injection = slugPromise
          .then((slug) => {
            state.slug = slug
            state.transcriptPath = mirrorPath(MIRROR_ROOT, slug, info.id)
            return runHook(
              "session-start-hook.sh",
              sessionStartPayload(info.id, state.transcriptPath, directory, "startup"),
              directory,
            )
          })
          .then((r) => r.stdout, () => "")
        sessions.set(info.id, state)
        return
      }

      if (event.type === "session.deleted") {
        const info = props.info as SessionLike | undefined
        if (!info?.id) return
        const state = sessions.get(info.id)
        if (state) endSession(state, "other")
        sessions.delete(info.id)
        return
      }

      if (event.type === "message.updated") {
        const info = props.info as { id?: string; sessionID?: string; role?: string } | undefined
        if (!info?.sessionID || info.role !== "user") return
        const state = sessions.get(info.sessionID)
        if (!state) return
        if (info.id && promptFired.has(info.id)) return
        if (info.id) promptFired.add(info.id)
        void (async () => {
          let prompt = ""
          try {
            if (info.id) {
              const res = await (client as unknown as OpenCodeClient).session.message({
                path: { id: info.sessionID!, messageID: info.id },
              })
              const body: unknown = Array.isArray(res)
                ? res
                : ((res as { data?: unknown }).data ?? res)
              const parts = (Array.isArray(body)
                ? body
                : ((body as { parts?: unknown }).parts ?? [])) as { type?: string; text?: string }[]
              prompt = parts
                .filter((p) => p?.type === "text" && typeof p.text === "string")
                .map((p) => p.text)
                .join("\n")
                .trim()
            }
          } catch {
            // The upstream hook reads nothing from this payload; the prompt
            // field exists for hooks.d listeners, so an unavailable prompt is
            // a degraded listener, never a capture failure.
          }
          fireHook(
            "user-prompt-hook.sh",
            userPromptPayload(state.id, state.transcriptPath, state.directory, prompt),
            state.directory,
          )
        })()
        return
      }

      if (event.type === "session.idle") {
        const sessionID = props.sessionID as string | undefined
        const state = sessionID ? sessions.get(sessionID) : undefined
        if (state && !state.ended) {
          void refreshMirror(state).catch(() => {})
        }
        return
      }
    },

    "tool.execute.after": async (input, output) => {
      const state = sessions.get(input.sessionID)
      if (!state || state.ended) return
      try {
        await refreshMirror(state)
      } catch {
        // A failed mirror write must not break the tool call; the next idle
        // event retries the same refresh.
      }
      fireHook(
        "post-tool-hook.sh",
        postToolPayload(
          state.id,
          state.transcriptPath,
          state.directory,
          input.tool,
          input.args,
          output.output,
        ),
        state.directory,
      )
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = sessions.get(input.sessionID)
      if (!state) return
      let injection = ""
      try {
        injection = await state.injection
      } catch {
        // An empty injection is an honest degraded state, not a failure of
        // the request.
      }
      // Pushed on EVERY request for the session, not once. The first request
      // opencode builds for a session is the title generation (small model),
      // and each request constructs its own system array from scratch - a
      // push consumed there is invisible to the answer request that follows.
      if (injection.trim()) {
        output.system.push(injection)
      }
    },

    dispose: async () => {
      for (const state of sessions.values()) {
        endSession(state, "other")
      }
      sessions.clear()
    },
  }
}
