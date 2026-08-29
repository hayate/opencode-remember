import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  serializeMirrorLine,
  serializeMirror,
  sessionStartPayload,
  sessionEndPayload,
  postToolPayload,
  userPromptPayload,
  mirrorPath,
  isSafeSessionId,
  type OpenCodeMessage,
} from "./lib.ts"

describe("serializeMirrorLine", () => {
  it("emits a user message with single text part as a plain string content", () => {
    const line = serializeMirrorLine({
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      parts: [{ type: "text", text: "Hello there" } as never],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.equal(obj.type, "user")
    assert.equal(obj.message.role, "user")
    assert.equal(obj.message.content, "Hello there")
    assert.equal(obj.session_id, "ses_1")
    assert.equal(obj.uuid, "msg_1")
    assert.ok(!("isMeta" in obj))
  })

  it("emits multiple user text parts as a content block list", () => {
    const line = serializeMirrorLine({
      id: "msg_2",
      sessionID: "ses_1",
      role: "user",
      parts: [
        { type: "text", text: "first" } as never,
        { type: "text", text: "second" } as never,
      ],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.deepEqual(obj.message.content, [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])
  })

  it("marks a user message whose text is entirely synthetic as isMeta", () => {
    const line = serializeMirrorLine({
      id: "msg_3",
      sessionID: "ses_1",
      role: "user",
      parts: [
        { type: "text", text: "continue", synthetic: true } as never,
      ],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.equal(obj.isMeta, true)
  })

  it("does not mark a mixed user message as isMeta", () => {
    const line = serializeMirrorLine({
      id: "msg_4",
      sessionID: "ses_1",
      role: "user",
      parts: [
        { type: "text", text: "continue", synthetic: true } as never,
        { type: "text", text: "real prompt" } as never,
      ],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.ok(!("isMeta" in obj))
  })

  it("skips a user message with no text parts", () => {
    const line = serializeMirrorLine({
      id: "msg_5",
      sessionID: "ses_1",
      role: "user",
      parts: [{ type: "file", mime: "image/png" } as never],
    } as OpenCodeMessage)
    assert.equal(line, null)
  })

  it("skips a user message whose only text is whitespace", () => {
    const line = serializeMirrorLine({
      id: "msg_6",
      sessionID: "ses_1",
      role: "user",
      parts: [{ type: "text", text: "   " } as never],
    } as OpenCodeMessage)
    assert.equal(line, null)
  })

  it("emits assistant text and tool_use blocks in order", () => {
    const line = serializeMirrorLine({
      id: "msg_7",
      sessionID: "ses_1",
      role: "assistant",
      parts: [
        { type: "text", text: "checking now" } as never,
        {
          type: "tool",
          tool: "Read",
          state: { status: "completed", input: { file_path: "/a/b.php" } },
        } as never,
        { type: "text", text: "done" } as never,
      ],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.equal(obj.type, "assistant")
    assert.equal(obj.message.role, "assistant")
    assert.deepEqual(obj.message.content, [
      { type: "text", text: "checking now" },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b.php" } },
      { type: "text", text: "done" },
    ])
  })

  it("emits tool_use with an empty input object when state.input is missing", () => {
    const line = serializeMirrorLine({
      id: "msg_8",
      sessionID: "ses_1",
      role: "assistant",
      parts: [
        { type: "tool", tool: "Bash", state: { status: "pending" } } as never,
      ],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.deepEqual(obj.message.content, [
      { type: "tool_use", name: "Bash", input: {} },
    ])
  })

  it("skips an assistant message that is only reasoning", () => {
    const line = serializeMirrorLine({
      id: "msg_9",
      sessionID: "ses_1",
      role: "assistant",
      parts: [{ type: "reasoning", text: "thinking..." } as never],
    } as OpenCodeMessage)
    assert.equal(line, null)
  })

  it("skips an assistant message that is only step markers", () => {
    const line = serializeMirrorLine({
      id: "msg_10",
      sessionID: "ses_1",
      role: "assistant",
      parts: [
        { type: "step-start" } as never,
        { type: "step-finish" } as never,
      ],
    } as OpenCodeMessage)
    assert.equal(line, null)
  })

  it("escapes hostile text through JSON encoding without touching it", () => {
    const nasty = 'line1\u2028end\n"quoted"\u0000tail'
    const line = serializeMirrorLine({
      id: "msg_11",
      sessionID: "ses_1",
      role: "user",
      parts: [{ type: "text", text: nasty } as never],
    } as OpenCodeMessage)
    assert.ok(line)
    const obj = JSON.parse(line)
    assert.equal(obj.message.content, nasty)
    assert.ok(!line.includes("\n"))
  })
})

describe("serializeMirror", () => {
  it("emits one JSON line per extractable message plus a trailing newline", () => {
    const messages: OpenCodeMessage[] = [
      {
        id: "m1",
        sessionID: "ses_1",
        role: "user",
        parts: [{ type: "text", text: "hi" } as never],
      },
      {
        id: "m2",
        sessionID: "ses_1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "..." } as never],
      },
      {
        id: "m3",
        sessionID: "ses_1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" } as never],
      },
    ]
    const out = serializeMirror(messages, "ses_1")
    const lines = out.split("\n")
    assert.equal(out.endsWith("\n"), true)
    assert.equal(lines.filter((l) => l !== "").length, 2)
    assert.equal(JSON.parse(lines[0]).uuid, "m1")
    assert.equal(JSON.parse(lines[1]).uuid, "m3")
  })
})

describe("payload synthesis", () => {
  it("sessionStartPayload carries session_id, transcript_path, cwd, source", () => {
    const obj = JSON.parse(sessionStartPayload("ses_1", "/mirror/projects/p/ses_1.jsonl", "/work", "startup"))
    assert.deepEqual(obj, {
      session_id: "ses_1",
      transcript_path: "/mirror/projects/p/ses_1.jsonl",
      cwd: "/work",
      source: "startup",
      hook_event_name: "SessionStart",
    })
  })

  it("sessionEndPayload carries session_id, transcript_path, cwd, reason", () => {
    const obj = JSON.parse(sessionEndPayload("ses_1", "/mirror/projects/p/ses_1.jsonl", "/work", "other"))
    assert.deepEqual(obj, {
      session_id: "ses_1",
      transcript_path: "/mirror/projects/p/ses_1.jsonl",
      cwd: "/work",
      reason: "other",
      hook_event_name: "SessionEnd",
    })
  })

  it("postToolPayload carries the tool call fields", () => {
    const obj = JSON.parse(
      postToolPayload("ses_1", "/mirror/projects/p/ses_1.jsonl", "/work", "Bash", { command: "git status" }, "On branch main"),
    )
    assert.deepEqual(obj, {
      session_id: "ses_1",
      transcript_path: "/mirror/projects/p/ses_1.jsonl",
      cwd: "/work",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: "On branch main",
    })
  })

  it("userPromptPayload carries session_id, transcript_path, cwd, prompt", () => {
    const obj = JSON.parse(userPromptPayload("ses_1", "/mirror/projects/p/ses_1.jsonl", "/work", "do the thing"))
    assert.deepEqual(obj, {
      session_id: "ses_1",
      transcript_path: "/mirror/projects/p/ses_1.jsonl",
      cwd: "/work",
      hook_event_name: "UserPromptSubmit",
      prompt: "do the thing",
    })
  })
})

describe("mirrorPath", () => {
  it("joins mirror root, slug and session id with a trailing-root tolerance", () => {
    assert.equal(
      mirrorPath("/home/u/.cache/opencode/remember-mirror", "-work", "ses_1"),
      "/home/u/.cache/opencode/remember-mirror/projects/-work/ses_1.jsonl",
    )
    assert.equal(
      mirrorPath("/home/u/.cache/opencode/remember-mirror/", "-work", "ses_1"),
      "/home/u/.cache/opencode/remember-mirror/projects/-work/ses_1.jsonl",
    )
  })
})

describe("isSafeSessionId", () => {
  it("accepts opencode session ids", () => {
    assert.equal(isSafeSessionId("ses_abc123-DEF.xyz"), true)
    assert.equal(isSafeSessionId("0123456789abcdef"), true)
  })

  it("rejects ids that are not path-component safe", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a b", "a\tb", "a\nb"]) {
      assert.equal(isSafeSessionId(bad), false, JSON.stringify(bad))
    }
  })
})
