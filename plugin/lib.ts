// Pure logic for the OpenCode adapter: mirror serialization and hook
// payload synthesis. No Bun imports and only erasable TypeScript, so this
// file runs under both Bun (inside OpenCode) and plain Node (node --test).

export type OpenCodeToolState = {
  status?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
}

export type OpenCodePart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; state?: OpenCodeToolState }
  | { type: "file" }
  | { type: "step-start" }
  | { type: "step-finish" }

export type OpenCodeMessage = {
  id?: string
  sessionID?: string
  role: "user" | "assistant"
  parts?: OpenCodePart[]
}

// The mirror is a Claude-format JSONL transcript of the OpenCode session,
// consumed by the unchanged upstream pipeline (pipeline/extract.py). The
// format is pinned by upstream tests/test_extract.py: lines of
// {"type": "user"|"assistant", "message": {"content": ...}} with optional
// isMeta, session_id and uuid fields.
export function serializeMirrorLine(message: OpenCodeMessage): string | null {
  const sessionID = message.sessionID ?? ""
  const line = (content: unknown, extra?: Record<string, unknown>) =>
    JSON.stringify({
      type: message.role,
      message: { role: message.role, content },
      session_id: sessionID,
      uuid: message.id ?? "",
      ...(extra ?? {}),
    })

  if (message.role === "user") {
    const texts = (message.parts ?? [])
      .filter((p): p is Extract<OpenCodePart, { type: "text" }> => p.type === "text")
      .map((p) => p.text.trim())
      .filter((t) => t.length > 0)
    if (texts.length === 0) return null
    const allSynthetic = (message.parts ?? [])
      .filter((p): p is Extract<OpenCodePart, { type: "text" }> => p.type === "text")
      .every((p) => p.synthetic === true)
    const content: string | { type: "text"; text: string }[] =
      texts.length === 1
        ? texts[0]
        : texts.map((text) => ({ type: "text", text }))
    return allSynthetic ? line(content, { isMeta: true }) : line(content)
  }

  const blocks: ({ type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> })[] = []
  for (const part of message.parts ?? []) {
    if (part.type === "text") {
      const text = part.text.trim()
      if (text.length > 0) blocks.push({ type: "text", text })
    } else if (part.type === "tool") {
      const input =
        part.state?.input && typeof part.state.input === "object" ? part.state.input : {}
      blocks.push({ type: "tool_use", name: part.tool, input })
    }
  }
  if (blocks.length === 0) return null
  return line(blocks)
}

export function serializeMirror(messages: OpenCodeMessage[], sessionID: string): string {
  const lines = messages
    .map((m) => serializeMirrorLine({ ...m, sessionID: m.sessionID ?? sessionID }))
    .filter((l): l is string => l !== null)
  return lines.length === 0 ? "" : lines.join("\n") + "\n"
}

export function sessionStartPayload(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  source: string,
): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    source,
    hook_event_name: "SessionStart",
  })
}

export function sessionEndPayload(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  reason: string,
): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    reason,
    hook_event_name: "SessionEnd",
  })
}

export function postToolPayload(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  })
}

export function userPromptPayload(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
  prompt: string,
): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: "UserPromptSubmit",
    prompt,
  })
}

export function mirrorPath(mirrorRoot: string, slug: string, sessionId: string): string {
  return `${mirrorRoot.replace(/\/+$/, "")}/projects/${slug}/${sessionId}.jsonl`
}

// The same allowlist the upstream hooks apply to stdin session ids: the id
// becomes a path component under the transcript directory.
export function isSafeSessionId(id: string): boolean {
  if (id === "." || id === "..") return false
  return /^[A-Za-z0-9._-]+$/.test(id)
}
