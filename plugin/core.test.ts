import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  createCore,
  nestedGuardDisabled,
  type Core,
  type SpawnResult,
} from "./core.ts"

const SLUG = "-tmp-proj"
const MIRROR_ROOT = "/mirror"
const ROOT = "/plugin-root"
const SID = "ses_abc123DEF"

type FakeState = {
  calls: { args: string[]; opts: { cwd?: string; stdin?: string; env?: Record<string, string> } }[]
  hookStdout: Record<string, string>
  slug: string
  messages: unknown[]
  message: unknown
  written: { path: string; content: string }[]
  logs: string[]
  core: Core
}

function makeFake(opts?: { slug?: string; hookStdout?: Record<string, string>; messages?: unknown[]; message?: unknown }): FakeState {
  const state: Omit<FakeState, "core"> = {
    calls: [],
    hookStdout: opts?.hookStdout ?? {},
    slug: opts?.slug ?? SLUG,
    messages: opts?.messages ?? [],
    message: opts?.message ?? { parts: [{ type: "text", text: "hi" }] },
    written: [],
    logs: [],
  }
  const core = createCore({
    root: ROOT,
    mirrorRoot: MIRROR_ROOT,
    client: {
      session: {
        messages: async () => state.messages,
        message: async () => state.message,
      },
    },
    spawn: async (args, spawnOpts): Promise<SpawnResult> => {
      state.calls.push({ args, opts: spawnOpts })
      if (args[0] === "bash" && args[1] === "-c") return { stdout: state.slug, stderr: "", exit: 0 }
      const script = args[1]?.split("/").pop() ?? ""
      return { stdout: state.hookStdout[script] ?? "", stderr: state.hookStdout[`${script}.stderr`] ?? "", exit: state.hookStdout[`${script}.exit`] ? 1 : 0 }
    },
    writeMirror: async (path, content) => {
      state.written.push({ path, content })
    },
    log: (message) => {
      state.logs.push(message)
    },
    defaultDirectory: "/proj",
  })
  return { ...state, core }
}

const hookCalls = (s: FakeState) =>
  s.calls.filter((c) => c.args[0] === "bash" && c.args[1]?.endsWith(".sh"))

const scriptOf = (c: { args: string[] }) => c.args[1].split("/").pop()

beforeEach(() => {})

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("nestedGuardDisabled", () => {
  it("is on for the summarizer marker only", () => {
    assert.equal(nestedGuardDisabled({ REMEMBER_NESTED_SUMMARIZER: "1" }), true)
    assert.equal(nestedGuardDisabled({ REMEMBER_NESTED_SUMMARIZER: "0" }), false)
    assert.equal(nestedGuardDisabled({}), false)
  })
})

describe("session.created", () => {
  it("fires SessionStart once with the synthesized payload and hook env", async () => {
    const s = makeFake({ hookStdout: { "session-start-hook.sh": "=== MEMORY ===" } })
    await s.core.handleEvent({
      type: "session.created",
      properties: { info: { id: SID, directory: "/proj" } },
    })
    await s.core.handleEvent({
      type: "session.created",
      properties: { info: { id: SID, directory: "/proj" } },
    })
    const starts = hookCalls(s).filter((c) => scriptOf(c) === "session-start-hook.sh")
    assert.equal(starts.length, 1)
    const payload = JSON.parse(starts[0].opts.stdin!)
    assert.deepEqual(payload, {
      session_id: SID,
      transcript_path: `${MIRROR_ROOT}/projects/${SLUG}/${SID}.jsonl`,
      cwd: "/proj",
      source: "startup",
      hook_event_name: "SessionStart",
    })
    assert.equal(starts[0].opts.env!.PLUGIN_ROOT, ROOT)
    assert.equal(starts[0].opts.env!.CLAUDE_CONFIG_DIR, MIRROR_ROOT)
    assert.equal(starts[0].opts.env!.CLAUDE_PROJECT_DIR, "/proj")
    assert.equal(starts[0].opts.env!.REMEMBER_HOOK_CWD, "/proj")
  })

  it("rejects a hostile session id before any spawn or state", async () => {
    const s = makeFake()
    await s.core.handleEvent({
      type: "session.created",
      properties: { info: { id: "../evil", directory: "/proj" } },
    })
    assert.equal(hookCalls(s).length, 0)
  })

  it("disables capture for the session when the slug cannot be computed", async () => {
    const s = makeFake({ slug: "" })
    await s.core.handleEvent({
      type: "session.created",
      properties: { info: { id: SID, directory: "/proj" } },
    })
    assert.equal(hookCalls(s).length, 0)
    assert.ok(s.logs.some((l) => l.includes("could not compute session slug")))
    const out = { system: [] }
    await s.core.onSystemTransform({ sessionID: SID }, out)
    assert.deepEqual(out.system, [])
  })

  it("dedupes session.updated against an existing session", async () => {
    const s = makeFake()
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.handleEvent({ type: "session.updated", properties: { info: { id: SID, directory: "/proj" } } })
    assert.equal(hookCalls(s).filter((c) => scriptOf(c) === "session-start-hook.sh").length, 1)
  })
})

describe("injection via system.transform", () => {
  it("pushes the SessionStart output on every request", async () => {
    const s = makeFake({ hookStdout: { "session-start-hook.sh": "=== MEMORY ===\npecorino" } })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    const out1 = { system: [] }
    await s.core.onSystemTransform({ sessionID: SID }, out1)
    const out2 = { system: [] }
    await s.core.onSystemTransform({ sessionID: SID }, out2)
    assert.deepEqual(out1.system, ["=== MEMORY ===\npecorino"])
    assert.deepEqual(out2.system, ["=== MEMORY ===\npecorino"])
  })

  it("pushes nothing for an empty injection or an unknown session", async () => {
    const s = makeFake()
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    const out = { system: [] }
    await s.core.onSystemTransform({ sessionID: SID }, out)
    assert.deepEqual(out.system, [])
    const out2 = { system: [] }
    await s.core.onSystemTransform({ sessionID: "ses_unknown" }, out2)
    assert.deepEqual(out2.system, [])
  })
})

describe("tool.execute.after", () => {
  it("refreshes the mirror then fires PostToolUse with the tool payload", async () => {
    const s = makeFake({
      messages: [
        {
          info: { id: "m1", sessionID: SID, role: "user" },
          parts: [{ type: "text", text: "do it" }],
        },
      ],
    })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.onToolAfter(
      { tool: "Bash", sessionID: SID, callID: "c1", args: { command: "ls" } },
      { title: "", output: "file.txt", metadata: {} },
    )
    assert.equal(s.written.length, 1)
    assert.equal(s.written[0].path, `${MIRROR_ROOT}/projects/${SLUG}/${SID}.jsonl`)
    const posts = hookCalls(s).filter((c) => scriptOf(c) === "post-tool-hook.sh")
    assert.equal(posts.length, 1)
    assert.deepEqual(JSON.parse(posts[0].opts.stdin!), {
      session_id: SID,
      transcript_path: `${MIRROR_ROOT}/projects/${SLUG}/${SID}.jsonl`,
      cwd: "/proj",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "file.txt",
    })
  })

  it("does not truncate an existing mirror when the message list is empty", async () => {
    const s = makeFake({ messages: [] })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.onToolAfter(
      { tool: "Bash", sessionID: SID, callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )
    assert.equal(s.written.length, 0)
    assert.equal(hookCalls(s).filter((c) => scriptOf(c) === "post-tool-hook.sh").length, 1)
  })
})

describe("session end", () => {
  it("refreshes the mirror before the flush and never double-fires", async () => {
    const s = makeFake({
      messages: [
        {
          info: { id: "m1", sessionID: SID, role: "user" },
          parts: [{ type: "text", text: "last turn" }],
        },
      ],
    })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.handleEvent({ type: "session.deleted", properties: { info: { id: SID } } })
    await flush()
    await flush()
    const ends = hookCalls(s).filter((c) => scriptOf(c) === "session-end-hook.sh")
    assert.equal(ends.length, 1)
    assert.equal(JSON.parse(ends[0].opts.stdin!).reason, "other")
    assert.equal(s.written.length, 1, "the flush must have refreshed the mirror first")
    await s.core.dispose()
    assert.equal(hookCalls(s).filter((c) => scriptOf(c) === "session-end-hook.sh").length, 1)
  })

  it("flushes tracked sessions on dispose", async () => {
    const s = makeFake()
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.dispose()
    assert.equal(hookCalls(s).filter((c) => scriptOf(c) === "session-end-hook.sh").length, 1)
  })
})

describe("user prompts", () => {
  it("fires UserPromptSubmit once per user message with the prompt text", async () => {
    const s = makeFake({ message: { parts: [{ type: "text", text: "the prompt" }] } })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    const ev = () => s.core.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: SID, role: "user" } },
    })
    await ev()
    await ev()
    const prompts = hookCalls(s).filter((c) => scriptOf(c) === "user-prompt-hook.sh")
    assert.equal(prompts.length, 1)
    assert.equal(JSON.parse(prompts[0].opts.stdin!).prompt, "the prompt")
  })

  it("ignores non-user messages and unknown sessions", async () => {
    const s = makeFake()
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: SID, role: "assistant" } },
    })
    await s.core.handleEvent({
      type: "message.updated",
      properties: { info: { id: "msg_2", sessionID: "ses_unknown", role: "user" } },
    })
    assert.equal(hookCalls(s).filter((c) => scriptOf(c) === "user-prompt-hook.sh").length, 0)
  })
})

describe("session.idle", () => {
  it("refreshes the mirror for a live session", async () => {
    const s = makeFake({
      messages: [
        {
          info: { id: "m1", sessionID: SID, role: "assistant" },
          parts: [{ type: "text", text: "answer" }],
        },
      ],
    })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.handleEvent({ type: "session.idle", properties: { sessionID: SID } })
    assert.equal(s.written.length, 1)
    assert.ok(s.written[0].content.includes('"uuid":"m1"'))
  })
})

describe("failure observability", () => {
  it("logs a hook that exits non-zero, with a bounded stderr detail", async () => {
    const s = makeFake({
      hookStdout: {
        "session-start-hook.sh": "",
        "session-start-hook.sh.stderr": "bash: something went wrong",
        "session-start-hook.sh.exit": "1",
      },
    })
    await s.core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await s.core.onSystemTransform({ sessionID: SID }, { system: [] })
    assert.ok(
      s.logs.some((l) => l.includes("session-start-hook.sh exited 1") && l.includes("something went wrong")),
      s.logs.join("\n"),
    )
  })

  it("logs a hook that cannot be spawned at all", async () => {
    const state = {
      calls: [] as unknown[],
      logs: [] as string[],
      written: [] as { path: string; content: string }[],
    }
    const core = createCore({
      root: ROOT,
      mirrorRoot: MIRROR_ROOT,
      client: { session: { messages: async () => [], message: async () => ({}) } },
      spawn: async () => {
        throw new Error("spawn ENOENT")
      },
      writeMirror: async (path, content) => {
        state.written.push({ path, content })
      },
      log: (m) => state.logs.push(m),
      defaultDirectory: "/proj",
    })
    await core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    await core.onSystemTransform({ sessionID: SID }, { system: [] })
    assert.ok(state.logs.some((l) => l.includes("could not compute session slug") || l.includes("spawn ENOENT")))
  })
})

describe("mirror refresh serialization", () => {
  it("never lets an older snapshot commit after a newer one", async () => {
    let call = 0
    const written: { path: string; content: string }[] = []
    const core = createCore({
      root: ROOT,
      mirrorRoot: MIRROR_ROOT,
      client: {
        session: {
          messages: async () => {
            call += 1
            if (call === 1) {
              await new Promise((r) => setTimeout(r, 50))
              return [{ info: { id: "old", sessionID: SID, role: "user" }, parts: [{ type: "text", text: "OLD" }] }]
            }
            return [{ info: { id: "new", sessionID: SID, role: "user" }, parts: [{ type: "text", text: "NEW" }] }]
          },
          message: async () => ({}),
        },
      },
      spawn: async () => ({ stdout: SLUG, stderr: "", exit: 0 }),
      writeMirror: async (path, content) => {
        written.push({ path, content })
      },
      log: () => {},
      defaultDirectory: "/proj",
    })
    await core.handleEvent({ type: "session.created", properties: { info: { id: SID, directory: "/proj" } } })
    const first = core.onToolAfter(
      { tool: "Bash", sessionID: SID, callID: "c1", args: {} },
      { title: "", output: "", metadata: {} },
    )
    const second = core.onToolAfter(
      { tool: "Bash", sessionID: SID, callID: "c2", args: {} },
      { title: "", output: "", metadata: {} },
    )
    await Promise.all([first, second])
    assert.ok(written.length >= 2)
    assert.ok(written[written.length - 1].content.includes("NEW"), "the newest snapshot must commit last")
  })
})
