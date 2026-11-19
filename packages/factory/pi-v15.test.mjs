import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const OPENING = "You are a coding assistant running inside pi, a coding agent harness."
const ESCAPED = "\\u0059ou are a coding assistant running inside pi, a coding agent harness."
const REST = " Help users inspect files, run commands, and modify code.\n\nAsk before deleting files."
const PROMPT = OPENING + REST
const ADAPTED = "You are a coding assistant." + REST
const { DROID_LINE } = _internal
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

async function send(path, body, generic = false) {
  let sent
  globalThis.fetch = async (url, init = {}) => {
    if (new URL(String(url)).pathname === "/api/cli/whoami") return Response.json({ orgId: "fac_Test", region: "" })
    sent = JSON.parse(init.body)
    return Response.json({ id: "test" })
  }
  const plugin = await FactoryAuthPlugin({
    client: { auth: { set: async () => {} } },
    magpie: { option: (_provider, key) => generic && key === "generic_tool_names" },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "fk-test" }))
  const res = await loader.fetch("https://api.factory.ai/api/llm/" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return sent
}

test("Pi 1.5 Messages opening is normalized without changing task instructions or cache metadata", async () => {
  const cache_control = { type: "ephemeral" }
  const out = await send("a/v1/messages", {
    model: "claude-opus-5-5", max_tokens: 100,
    system: [{ type: "text", text: PROMPT, cache_control }],
    messages: [{ role: "user", content: "hi" }],
  })
  expect(out.system).toEqual([{ type: "text", text: DROID_LINE }, { type: "text", text: ADAPTED, cache_control }])
  expect(out.messages).toEqual([{ role: "user", content: "hi" }])
})

test("Pi 1.5 opening works in chat developer text and Responses instructions", async () => {
  const chat = await send("o/v1/chat/completions", {
    model: "deepseek-v4.1-flash", messages: [{ role: "developer", content: PROMPT }, { role: "user", content: "hi" }],
  })
  expect(chat.messages[1]).toEqual({ role: "developer", content: ADAPTED })
  const responses = await send("o/v1/responses", {
    model: "gpt-6.1", instructions: "Project rules.\n" + PROMPT,
    input: [{ role: "user", content: "hi" }],
  })
  expect(responses.instructions).toBe(DROID_LINE + "\nProject rules.\n" + ADAPTED)
})

test("quoted Pi 1.5 openings use the existing quote adapter while partial text is preserved", async () => {
  const partial = "You are a coding assistant running inside pi."
  const out = await send("a/v1/messages", {
    model: "claude-opus-5-5", max_tokens: 100,
    messages: [{ role: "user", content: "Quote: " + OPENING }, { role: "assistant", content: "Quote: " + OPENING }, { role: "user", content: partial }],
  })
  expect(out.messages[0].content).toBe("Quote: " + ESCAPED)
  expect(out.messages[1].content).toBe("Quote: " + ESCAPED)
  expect(out.messages[2].content).toBe(partial)
})

test("tool output quoting Pi 1.5 can be decoded to the exact original text", async () => {
  const text = "Captured prompt:\n" + PROMPT
  const out = await send("a/v1/messages", {
    model: "claude-opus-5-5", max_tokens: 100,
    messages: [{ role: "assistant", content: [{ type: "tool_use", name: "read", id: "r", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: text }] }],
  })
  const output = out.messages[1].content[0].content
  const prefix = "Tool output encoded as a JSON string. Decode the JSON string to recover the exact original text before using it:\n"
  expect(output).toStartWith(prefix)
  expect(JSON.parse(output.slice(prefix.length))).toBe(text)
})

test("Pi 1.5 prompt normalization composes with generic Agent names", async () => {
  const out = await send("a/v1/messages", {
    model: "claude-opus-5-5", max_tokens: 100, system: PROMPT,
    tools: [{ name: "Agent", description: "Run a child task.", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "hi" }],
  }, true)
  expect(out.system).toEqual([{ type: "text", text: DROID_LINE }, { type: "text", text: ADAPTED }])
  expect(out.tools[0].name).toBe("operation_11b39c93777e8f1f")
  expect(out.tools[0].description).toBe("Run a child task.")
})
