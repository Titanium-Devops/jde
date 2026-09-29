# JDE as an MCP server

`jde-mcp` gives any MCP client two tools: `check_completion`, which an agent calls before it
reports a task done, and `ask`, for typed questions. It needs a judge running:

```bash
pip install jebadiah-decide && jeb serve
```

**Claude Code**

```bash
claude mcp add jde -- npx -y -p jde jde-mcp
```

**Cursor**: copy [`cursor-mcp.json`](cursor-mcp.json) to `.cursor/mcp.json` in your project, or
`~/.cursor/mcp.json` for every project.

**Any other client**: [`mcp-servers.json`](mcp-servers.json) is the usual `mcpServers` block.

Settings, all optional, go in the server's `env`:

| Setting | Default | |
|---|---|---|
| `JDE_JEB_ENDPOINT` | `http://localhost:8100/v1/systemone` | where the judge is |
| `JDE_JEB_MODEL` | `jebadiah-9b-v2` | the model name sent and recorded |
| `JDE_TIMEOUT_MS` | the policy's (2000) | raises the deadline for a slower local model; never lowers it |
| `JDE_JUDGE` | `jeb` | `jev` for TypeSafe's hosted judge, with `TYPESAFE_API_KEY` |
| `JDE_LEDGER` | on | `off` records nothing; otherwise rows go to `JDE_LEDGER_PATH` (`.jde/ledger.jsonl`) |

To make an agent use it, tell it so, for example in `CLAUDE.md` or a Cursor rule:

> Before you tell me a task is finished, call `check_completion` with the receipts from your own
> tool log. If the verdict is not `done`, finish the missing parts first.
