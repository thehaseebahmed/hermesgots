// How a row says how it is doing, and what a server's Config tab sends: the rules themselves are
// pure (`src/lib/mcp-server.ts`), so the cases that read oddly — a server the Host reports no tool
// count for, a line of arguments with a path that has a space in it, a field left empty because the
// bot already holds that value — are here rather than in the browser flow.
import assert from "node:assert/strict"
import test from "node:test"

import {
  configChanged,
  configDraft,
  configEdit,
  customReady,
  customServer,
  healthLine,
  joinArgs,
  splitArgs,
  typedValues,
} from "../src/lib/mcp-server.ts"

const server = (patch) => ({
  name: "srv",
  state: "on",
  enabled: true,
  source: "config",
  access: { grantable: false, authenticated: false },
  ...patch,
})

test("a healthy server with a known count says how many tools it brings", () => {
  assert.deepEqual(healthLine(server({ tools: 78 })), {
    text: "Healthy: 78 tools",
    authenticate: false,
    failed: false,
  })
})

test("one tool is a tool, not tools", () => {
  assert.equal(healthLine(server({ tools: 1 })).text, "Healthy: 1 tool")
})

test("a server with no known count says Healthy and no number", () => {
  assert.equal(healthLine(server()).text, "Healthy")
  assert.equal(healthLine(server({ source: "plugin", state: "plugin" })).text, "Healthy")
})

test("a waiting server invites the tap where the Host can start the flow", () => {
  assert.deepEqual(
    healthLine(server({ state: "needs_access", access: false }), { canAuthenticate: true }),
    {
      text: "Click here to authenticate",
      authenticate: true,
      failed: false,
    },
  )
})

test("a waiting server whose Host can't start the flow says so without inviting a tap", () => {
  const line = healthLine(server({ state: "needs_access" }), { canAuthenticate: false })
  assert.equal(line.text, "Waiting on Server access")
  assert.equal(line.authenticate, false)
})

test("the Host's own failure text is the line, whatever word the server carries", () => {
  assert.deepEqual(healthLine(server({ state: "failed", reason: "401 Unauthorized" })), {
    text: "401 Unauthorized",
    authenticate: false,
    failed: true,
  })
  assert.equal(
    healthLine(server({ state: "plugin", source: "plugin", reason: "spawn failed" })).text,
    "spawn failed",
  )
})

test("a failed server whose access the Host can start says its reason, as the tap that can fix it", () => {
  const line = healthLine(server({ state: "failed", reason: "401 Unauthorized" }), {
    canAuthenticate: true,
  })
  assert.equal(line.text, "401 Unauthorized")
  assert.equal(line.authenticate, true)
  assert.equal(line.failed, true)
})

test("a failed server whose access can't be started keeps its reason as text", () => {
  const line = healthLine(server({ state: "failed", reason: "401 Unauthorized" }))
  assert.equal(line.authenticate, false)
})

test("a failed server the Host gives no reason for still says Failed", () => {
  assert.equal(healthLine(server({ state: "failed" })).text, "Failed")
})

test("off and connecting are their own lines, and an off server is never Healthy", () => {
  assert.equal(healthLine(server({ state: "off", enabled: false, tools: 4 })).text, "Off")
  assert.equal(healthLine(server({ state: "connecting" })).text, "Connecting…")
})

test("Server access outranks a failure the Host reports underneath it", () => {
  const line = healthLine(server({ state: "needs_access", reason: "auth error" }), {
    canAuthenticate: true,
  })
  assert.equal(line.text, "Click here to authenticate")
})

test("arguments survive a line with a path that has a space in it", () => {
  const argv = ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/My Documents"]
  assert.deepEqual(splitArgs(joinArgs(argv)), argv)
})

test("a quote inside an argument survives too", () => {
  const argv = ["--label", 'say "hi"']
  assert.deepEqual(splitArgs(joinArgs(argv)), argv)
})

test("arguments split the way a shell splits them", () => {
  assert.deepEqual(splitArgs("  -y   srv  "), ["-y", "srv"])
  assert.deepEqual(splitArgs("'one two' three"), ["one two", "three"])
  assert.deepEqual(splitArgs('"a b" c'), ["a b", "c"])
  assert.deepEqual(splitArgs("a\\ b"), ["a b"])
  assert.deepEqual(splitArgs(""), [])
  assert.deepEqual(splitArgs("   "), [])
})

test("an unclosed quote keeps what was typed rather than losing the rest", () => {
  assert.deepEqual(splitArgs('"half an argument'), ["half an argument"])
})

test("an empty argument is kept as one", () => {
  assert.deepEqual(splitArgs('"" second'), ["", "second"])
})

test("only the values typed over are sent", () => {
  assert.deepEqual(
    typedValues([
      { name: "PG_TOKEN", value: "" },
      { name: "PG_URL", value: "  " },
      { name: "PG_PASSWORD", value: "hunter2" },
      { name: "", value: "nameless" },
    ]),
    { PG_PASSWORD: "hunter2" },
  )
})

const detail = {
  name: "pg",
  source: "config",
  transport: "stdio",
  url: "",
  command: "npx",
  args: ["-y", "pg-mcp"],
  auth: "none",
  editable: true,
  values: [],
}

test("a server's draft opens with what its block runs", () => {
  assert.deepEqual(configDraft(detail), {
    transport: "stdio",
    url: "",
    command: "npx",
    args: "-y pg-mcp",
    auth: "none",
    token: "",
  })
})

test("nothing changed is nothing to save", () => {
  assert.equal(configChanged(detail, configDraft(detail), []), false)
})

test("respacing the arguments is not a change", () => {
  const draft = { ...configDraft(detail), args: "  -y   pg-mcp " }
  assert.equal(configChanged(detail, draft, []), false)
})

test("a changed command, a typed value or a switched transport is a change", () => {
  assert.equal(configChanged(detail, { ...configDraft(detail), command: "uvx" }, []), true)
  assert.equal(configChanged(detail, configDraft(detail), [{ name: "PG_TOKEN", value: "x" }]), true)
  assert.equal(configChanged(detail, { ...configDraft(detail), transport: "http" }, []), true)
})

test("the edit carries the transport's own fields and the typed values", () => {
  assert.deepEqual(
    configEdit({ ...configDraft(detail), command: "npx", args: "-y pg-mcp" }, [
      { name: "PG_PASSWORD", value: "hunter2" },
      { name: "PG_TOKEN", value: "" },
    ]),
    {
      transport: "stdio",
      command: "npx",
      args: ["-y", "pg-mcp"],
      values: { PG_PASSWORD: "hunter2" },
    },
  )
})

test("an http edit carries its address, its auth and only a token that was typed", () => {
  const http = {
    ...detail,
    transport: "http",
    url: "https://pg.example/mcp",
    command: "",
    args: [],
    auth: "none",
  }
  assert.deepEqual(configEdit(configDraft(http), []), {
    transport: "http",
    url: "https://pg.example/mcp",
    auth: "none",
  })
  assert.deepEqual(configEdit({ ...configDraft(http), auth: "header", token: "sk-1" }, []), {
    transport: "http",
    url: "https://pg.example/mcp",
    auth: "header",
    token: "sk-1",
  })
})

test("a custom server needs a name and its transport's field", () => {
  const draft = {
    transport: "http",
    url: "https://ink.example/mcp",
    command: "",
    args: "",
    auth: "none",
    token: "",
  }
  assert.equal(customReady("", draft), false)
  assert.equal(customReady("ink", { ...draft, url: "  " }), false)
  assert.equal(customReady("ink", draft), true)
  assert.equal(customReady("ink", { ...draft, transport: "stdio", url: "", command: "npx" }), true)
})

test("a custom stdio server sends its arguments and values", () => {
  assert.deepEqual(
    customServer(
      " github ",
      {
        transport: "stdio",
        url: "",
        command: "npx",
        args: "-y @modelcontextprotocol/server-github",
        auth: "none",
        token: "",
      },
      [{ name: "GITHUB_TOKEN", value: "ghp_1" }],
    ),
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      values: { GITHUB_TOKEN: "ghp_1" },
    },
  )
})
