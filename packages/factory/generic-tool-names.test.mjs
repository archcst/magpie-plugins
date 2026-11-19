import { afterEach, expect, test } from "bun:test"
import { aliasToolNames, restoreToolNames, unwrapAnthropicTools, wrapAnthropicTools } from "./anthropic-tools.mjs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const READ = "operation_3316348dbadfb7b1"
const AGENT = "operation_11b39c93777e8f1f"
const refused = new Set(["read", "Agent"])
const tool = (name) => ({ name, description: "Read a file or run a task.", input_schema: { type: "object", properties: { path: { type: "string" } } } })
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mapped(dialect, body) {
  const result = aliasToolNames(dialect, JSON.stringify(body), refused, true)
  return { ...result, parsed: JSON.parse(result.body) }
}

function stream(events, chunkSize = 1) {
  const text = events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("")
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      const next = Math.min(offset + chunkSize, bytes.length)
      controller.enqueue(bytes.slice(offset, next))
      offset = next
    },
  }), { headers: { "content-type": "text/event-stream" } })
}
const frames = (text) => text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.slice(6)))

test("generic names are stable across tool order and include names outside the refusal list", () => {
  const first = mapped("anthropic", { tools: [tool("read"), tool("Agent"), tool("read_tool")], messages: [] })
  const second = mapped("anthropic", { tools: [tool("read_tool"), tool("Agent"), tool("read")], messages: [] })
  expect(first.parsed.tools.map((t) => t.name)).toEqual([READ, AGENT, "operation_14b963c81a3465b4"])
  expect(second.parsed.tools.map((t) => t.name)).toEqual([...first.parsed.tools.map((t) => t.name)].reverse())
  expect(first.aliases.get(READ)).toBe("read")
})

test("generic mode preserves descriptions, schemas, arguments and user text", () => {
  const body = {
    system: "Use read and Agent. No file changes.",
    tools: [tool("read"), tool("Agent")],
    tool_choice: { type: "tool", name: "Agent" },
    messages: [
      { role: "user", content: "read Agent" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: { path: "read" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Agent" }] },
    ],
  }
  const out = mapped("anthropic", body).parsed
  expect(out.tools[0]).toEqual({ ...body.tools[0], name: READ })
  expect(out.system).toBe(body.system)
  expect(out.tool_choice.name).toBe(AGENT)
  expect(out.messages[1].content[0]).toEqual({ ...body.messages[1].content[0], name: READ })
  expect(out.messages[0]).toEqual(body.messages[0])
  expect(out.messages[2]).toEqual(body.messages[2])
})

test("reserved names cannot collide and typed Anthropic tools retain their required names", () => {
  const typed = { type: "bash_20250124", name: "bash" }
  const out = mapped("anthropic", { tools: [tool("read"), tool(READ), typed], messages: [] })
  expect(out.parsed.tools[0].name).toBe(READ + "_2")
  expect(new Set(out.parsed.tools.map((t) => t.name)).size).toBe(3)
  expect(out.parsed.tools[2]).toEqual(typed)
  expect(out.aliases.get(READ + "_2")).toBe("read")
})

test("requests without function tools remain byte-identical", () => {
  for (const body of ['{ "messages": [] }', '{"tools":[{"type":"bash_20250124","name":"bash"}],"messages":[]}']) {
    expect(aliasToolNames("anthropic", body, refused, true).body).toBe(body)
  }
})

test("chat, Responses and Gemini map declarations, choices and history consistently", () => {
  const chat = mapped("chat", {
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "read" } },
    messages: [{ role: "assistant", tool_calls: [{ type: "function", function: { name: "read", arguments: '{"path":"read"}' } }] }],
  }).parsed
  expect(chat.tools[0].function.name).toBe(READ)
  expect(chat.tool_choice.function.name).toBe(READ)
  expect(chat.messages[0].tool_calls[0].function).toEqual({ name: READ, arguments: '{"path":"read"}' })
  const responses = mapped("responses", {
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "web_search" }],
    tool_choice: { type: "function", name: "read" }, input: [{ type: "function_call", name: "read", arguments: "{}" }],
  }).parsed
  expect(responses.tools[0].name).toBe(READ)
  expect(responses.tools[1]).toEqual({ type: "web_search" })
  expect(responses.tool_choice.name).toBe(READ)
  expect(responses.input[0].name).toBe(READ)
  const gemini = mapped("gemini", {
    tools: [{ functionDeclarations: [{ name: "read" }] }],
    contents: [{ parts: [{ functionCall: { name: "read", args: {} } }, { functionResponse: { name: "read", response: { output: "read" } } }] }],
    toolConfig: { functionCallingConfig: { allowedFunctionNames: ["read"] } },
  }).parsed
  expect(gemini.tools[0].functionDeclarations[0].name).toBe(READ)
  expect(gemini.contents[0].parts[0].functionCall.name).toBe(READ)
  expect(gemini.contents[0].parts[1].functionResponse.name).toBe(READ)
  expect(gemini.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual([READ])
})

test("generic names restore JSON replies on all four protocols", async () => {
  const aliases = new Map([[READ, "read"]])
  const a = await unwrapAnthropicTools(Response.json({ content: [{ type: "tool_use", name: READ, input: { path: READ } }] }), new Set(), aliases)
  expect((await a.json()).content[0]).toEqual({ type: "tool_use", name: "read", input: { path: READ } })
  const c = await restoreToolNames(Response.json({ choices: [{ message: { tool_calls: [{ function: { name: READ, arguments: "{}" } }] } }] }), "chat", aliases)
  expect((await c.json()).choices[0].message.tool_calls[0].function.name).toBe("read")
  const r = await restoreToolNames(Response.json({ output: [{ type: "function_call", name: READ }] }), "responses", aliases)
  expect((await r.json()).output[0].name).toBe("read")
  const g = await restoreToolNames(Response.json({ candidates: [{ content: { parts: [{ functionCall: { name: READ } }] } }] }), "gemini", aliases)
  expect((await g.json()).candidates[0].content.parts[0].functionCall.name).toBe("read")
})

test("streamed Agent calls restore names without rewriting text or arguments", async () => {
  const aliases = new Map([[AGENT, "Agent"]])
  for (const chunkSize of [1, 7, 4096]) {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: AGENT } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "a", name: AGENT, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"prompt":"读取文件"}' } },
      { type: "content_block_stop", index: 1 }, { type: "message_stop" },
    ]
    const out = frames(await (await unwrapAnthropicTools(stream(events, chunkSize), new Set(), aliases)).text())
    expect(out[0].content_block.text).toBe(AGENT)
    expect(out[1].content_block.name).toBe("Agent")
    expect(out[2].delta.partial_json).toBe('{"prompt":"读取文件"}')
  }
})

test("generic names compose with schema wrapping and restore arguments", async () => {
  const named = mapped("anthropic", {
    tools: [{ ...tool("read"), input_schema: { anyOf: [{ type: "object" }, { type: "string" }] } }],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: { path: "a" } }] }],
  })
  const wrapped = wrapAnthropicTools(named.body)
  expect(wrapped.names.has(READ)).toBe(true)
  expect(JSON.parse(wrapped.body).messages[0].content[0].input).toEqual({ arguments: { path: "a" } })
  const reply = await unwrapAnthropicTools(Response.json({ content: [{ type: "tool_use", name: READ, input: { arguments: { path: "b" } } }] }), wrapped.names, named.aliases)
  expect((await reply.json()).content[0]).toEqual({ type: "tool_use", name: "read", input: { path: "b" } })
})

test("the plugin option is opt-in and updates on the next request", async () => {
  let enabled = false
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/cli/whoami")) return Response.json({ orgId: "fac_Test", region: "" })
    const body = JSON.parse(init.body)
    sent.push(body)
    return Response.json({ content: [{ type: "tool_use", name: body.tools[0].name, input: { path: "x" } }] })
  }
  const hooks = await FactoryAuthPlugin({
    client: { auth: { set: async () => {} } },
    magpie: { option: (provider, key) => provider === "factory" && key === "generic_tool_names" && enabled },
  })
  expect(hooks.auth.options.some((o) => o.key === "generic_tool_names")).toBe(true)
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "fk-test" }))
  const request = () => loader.fetch("https://api.factory.ai/api/llm/a/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", system: _internal.DROID_LINE, max_tokens: 100, tools: [tool("read")], messages: [{ role: "user", content: "Read the fixture" }] }),
  })
  expect((await (await request()).json()).content[0].name).toBe("read")
  expect(sent.at(-1).tools[0].name).toBe("read_tool")
  enabled = true
  expect((await (await request()).json()).content[0].name).toBe("read")
  expect(sent.at(-1).tools[0].name).toBe(READ)
})
