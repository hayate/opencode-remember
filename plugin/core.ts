// The adapter's event-to-hook logic, dependency-injected so node --test can
// drive it without Bun or a running opencode. The entry plugin
// (opencode-remember.ts) is thin glue: real Bun spawn, the real SDK client,
// real filesystem writes.

import { join } from "node:path"

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

export type SpawnResult = { stdout: string; stderr: string; exit: number }

export type Spawn = (
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> },
) => Promise<SpawnResult>

export type CoreClient = {
  session: {
    messages(options: { path: { id: string } }): Promise<unknown>
    message(options: { path: { id: string; messageID: string } }): Promise<unknown>
  }
}

export type CoreInput = {
  root: string
  mirrorRoot: string
  client: CoreClient
  spawn: Spawn
  writeMirror(path: string, content: string): Promise<void>
  log(message: string): void
  defaultDirectory: string
}

type SessionState = {
  id: string
  directory: string
  slugPromise: Promise<string>
  slug: string
  transcriptPath: string
  ended: boolean
  injection: Promise<string>
  refreshQueue: Promise<unknown>
}

type CoreEvent = {
  type: string
  properties?: unknown
}

export type Core = {
  handleEvent(event: CoreEvent): Promise<void>
  onToolAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ): Promise<void>
  onSystemTransform(input: { sessionID?: string }, output: { system: string[] }): Promise<void>
  dispose(): Promise<void>
}

export function nestedGuardDisabled(env: Record<string, string | undefined>): boolean {
  return env["REMEMBER_NESTED_SUMMARIZER"] === "1"
}

export function createCore(input: CoreInput): Core {
  const { root, mirrorRoot, client, spawn, writeMirror, log, defaultDirectory } = input
  const SCRIPTS = join(root, "scripts")

  const sessions = new Map<string, SessionState>()
  const promptFired = new Set<string>()
  const slugCache = new Map<string, Promise<string>>()
  const pendingEnds = new Set<Promise<void>>()

  const slugFor = (dir: string): Promise<string> => {
    let cached = slugCache.get(dir)
    if (!cached) {
      cached = (async () => {
        // Compute the slug with the upstream function itself, so the mirror
        // directory and the hooks can never disagree about the spelling.
        const r = await spawn(
          ["bash", "-c", 'source "$0/scripts/lib-slug.sh" && session_dir_slug "$1"', root, dir],
          {},
        )
        const slug = r.stdout.trim()
        if (!slug) {
          // No invented fallback: a guessed slug would point the mirror at a
          // directory the pipeline never reads, and capture would silently
          // no-op. An empty slug disables this session's capture instead.
          log(`opencode-remember: could not compute session slug for ${dir}; capture disabled for this session`)
          return ""
        }
        return slug
      })()
      slugCache.set(dir, cached)
    }
    return cached
  }

  const runHook = async (script: string, stdinJson: string, cwd: string) => {
    const r = await spawn(["bash", join(SCRIPTS, script)], {
      cwd,
      stdin: stdinJson,
      env: {
        PLUGIN_ROOT: root,
        CLAUDE_CONFIG_DIR: mirrorRoot,
        CLAUDE_PROJECT_DIR: cwd,
        REMEMBER_HOOK_CWD: cwd,
        REMEMBER_CLAUDE_BIN: join(SCRIPTS, "summarizer-opencode.sh"),
      },
    })
    // The upstream hooks exit 0 by contract, so a non-zero exit is a broken
    // install or environment. Persist it - the hooks' own stderr already
    // lands in hook-errors.log, but a spawn-level failure (missing bash,
    // invalid cwd) never reaches it and would otherwise vanish.
    if (r.exit !== 0) {
      const detail = (r.stderr ?? "").slice(0, 300).trim()
      log(
        `opencode-remember: ${script} exited ${r.exit}${detail ? `: ${detail}` : ""}`,
      )
    }
    return r
  }

  const fireHook = (script: string, stdinJson: string, cwd: string) => {
    runHook(script, stdinJson, cwd).catch((error) => {
      // Hooks are fire-and-forget from the event loop's point of view: a
      // spawn failure must never surface into opencode's own event handling.
      log(`opencode-remember: ${script} failed to spawn: ${String(error)}`)
    })
  }

  const refreshMirror = async (state: SessionState) => {
    const run = state.refreshQueue.then(async () => {
      await state.slugPromise
      if (!state.transcriptPath) return
      const res: unknown = await client.session.messages({ path: { id: state.id } })
      const items = Array.isArray(res)
        ? (res as { info?: unknown; parts?: unknown }[])
        : ((res as { data?: { info?: unknown; parts?: unknown }[] }).data ?? [])
      const messages: OpenCodeMessage[] = []
      for (const item of items) {
        const info = item.info as { id?: string; sessionID?: string; role?: string } | undefined
        if (!info) continue
        messages.push({
          id: info.id,
          sessionID: info.sessionID,
          role: info.role === "assistant" ? "assistant" : "user",
          parts: (item.parts ?? []) as OpenCodeMessage["parts"],
        })
      }
      const jsonl = serializeMirror(messages, state.id)
      // A transiently empty read (session just created, an API hiccup) must
      // not atomically erase the transcript the pipeline has already consumed.
      if (!jsonl) return
      await writeMirror(state.transcriptPath, jsonl)
    })
    // Serialized per session: refreshes run in order, so an older snapshot
    // can never commit after a newer one, and each caller awaits its own
    // run while the next waits behind it.
    state.refreshQueue = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  const endSession = (state: SessionState, reason: string) => {
    if (state.ended) return
    state.ended = true
    const flush = state.slugPromise
      .then(async () => {
        if (!state.transcriptPath) return
        // Refresh BEFORE the flush: the end hook reads the mirror, and the
        // final turn's tail may never have been written (idle refreshes are
        // fire-and-forget). A failed final write must not block teardown;
        // the flush then reads the last completed mirror, and the next
        // session start's recovery block is the backstop.
        try {
          await refreshMirror(state)
        } catch {
          // degraded, not silent: the end hook's own save logs its failure
        }
        fireHook(
          "session-end-hook.sh",
          sessionEndPayload(state.id, state.transcriptPath, state.directory, reason),
          state.directory,
        )
      })
      .catch(() => {})
      .finally(() => {
        pendingEnds.delete(flush)
      })
    pendingEnds.add(flush)
  }

  return {
    async handleEvent(event: CoreEvent) {
      const props = (event.properties ?? {}) as Record<string, unknown>
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = props.info as { id?: string; directory?: string } | undefined
        if (!info?.id || !isSafeSessionId(info.id)) return
        const directory = info.directory || defaultDirectory
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
          refreshQueue: Promise.resolve(),
        }
        state.injection = slugPromise
          .then((slug) => {
            if (!slug) return ""
            state.slug = slug
            state.transcriptPath = mirrorPath(mirrorRoot, slug, info.id!)
            return runHook(
              "session-start-hook.sh",
              sessionStartPayload(info.id!, state.transcriptPath, directory, "startup"),
              directory,
            ).then((r) => r.stdout)
          })
          .catch((error) => {
            log(`opencode-remember: session-start hook failed: ${String(error)}`)
            return ""
          })
        sessions.set(info.id, state)
        return
      }

      if (event.type === "session.deleted") {
        const info = props.info as { id?: string } | undefined
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
              const res = await client.session.message({
                path: { id: info.sessionID!, messageID: info.id },
              })
              const body: unknown = Array.isArray(res) ? res : ((res as { data?: unknown }).data ?? res)
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
          await refreshMirror(state).catch(() => {})
        }
        return
      }
    },

    async onToolAfter(input, output) {
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

    async onSystemTransform(input, output) {
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

    async dispose() {
      for (const state of sessions.values()) {
        endSession(state, "other")
      }
      sessions.clear()
      // opencode awaits dispose: let the flush reach the mirror and the end
      // hook before the process goes away.
      if (pendingEnds.size > 0) {
        await Promise.all(pendingEnds).catch(() => {})
      }
    },
  }
}
