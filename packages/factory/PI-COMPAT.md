# Pi compatibility

This branch adds two Factory adapter features for Pi:

- Support for the system-prompt opening used by Pi 1.5, while preserving the task instructions that follow it. Older Pi openings remain supported.
- An optional generic tool-name mapping. Function tools receive stable `operation_<SHA256-prefix>` names on the wire. Replies restore the names Pi registered. Tool descriptions, schemas, arguments and permissions are unchanged by this mapping.

## Install in Magpie

Check out the `factory/pi-compat` branch, then add its Factory package as a local plugin:

```sh
magpie plugin add /path/to/magpie-plugins/packages/factory
magpie plugin options /path/to/magpie-plugins/packages/factory '{"generic_tool_names":true}'
```

Disable any other plugin serving the same `factory` provider. Existing Factory accounts can be reused; a new installation can sign in with:

```sh
magpie plugin login factory
```

Keep the checkout while Magpie uses it. Changes to plugin code require reloading the plugin. The generic-name option is read for each request and is off by default.

## Request handling

1. Map declared function tool names, tool choices and matching historical calls.
2. Send the adapted request through the existing Factory authentication and transport.
3. Restore original tool names in JSON and streamed replies.
4. Let Pi execute the original tools with their original arguments and permissions.

Hash-based names are independent of declaration order unless a reserved-name collision requires a numeric suffix. Typed Anthropic tools retain their required names. Prompt adaptation changes the known client opening; quoted client text uses the existing quote adapter.

## Verification

On 2026-11-19:

- 236 Factory tests passed.
- Pi 1.5.2 and Magpie 0.1.4445 completed a file-read test using Factory Opus 5.5.
- A foreground Agent call completed a child file read using the same Factory model and returned the exact result to the parent.

Live verification covers Anthropic Messages. Other protocol mappings have unit tests. Background workflows, images and long-history compaction have not been live-tested. Chat streams that split a tool name across separate SSE events retain the original adapter's limitation.

Run the package tests and plugin contract check from the repository root:

```sh
cd packages/factory
bun test
cd ../..
bun scripts/check.mjs factory
```

To disable generic tool-name mapping:

```sh
magpie plugin options /path/to/magpie-plugins/packages/factory '{"generic_tool_names":false}'
```

Factory can change its acceptance rules independently of this plugin. A passing test records the behavior at test time, not a stable upstream API guarantee.
