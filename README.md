# testmo-mcp

A Model Context Protocol (MCP) server that provides seamless integration with the Testmo test management platform. This server enables AI assistants to interact directly with your Testmo instance for test case management.

A small **local MCP server** that exposes [Testmo](https://www.testmo.com/)'s
REST API as tools, so an MCP client (Claude Desktop, Claude Code, etc.) can read
your projects/runs/results and create or update runs, results and test cases —
without any hosting and without pasting data back and forth.

It runs on your machine and talks to your Testmo instance over HTTPS using an API
token you supply via environment variables. The token is never written to disk by
the server.

## Tools

### Read
| Tool | What it does |
|---|---|
| `testmo_list_projects` | List all projects |
| `testmo_list_runs` | List manual runs in a project (name/closed/milestone filters, pagination) |
| `testmo_get_run` | One run's summary (status counts, totals) |
| `testmo_list_results` | Recorded results for a run |
| `testmo_list_statuses` | Result status IDs for a project (Passed/Failed/…) |
| `testmo_list_states` | Workflow state IDs (run/case/session) — for `state_id` when creating |
| `testmo_list_templates` | Case template IDs — for `template_id` / custom fields |
| `testmo_list_cases` | List repository cases (folder/name/template filters) |
| `testmo_get` | Raw GET against any `/api/v1` path (escape hatch) |

### Write (create/update — no delete)
| Tool | What it does |
|---|---|
| `testmo_record_result` | Record a result for one test |
| `testmo_record_results_bulk` | Record results for 1–100 tests in one request |
| `testmo_create_run` | Create a manual run (`name`, `state_id`, `include_all` required) |
| `testmo_update_run` | Update a run; set `is_closed=true` to close it |
| `testmo_create_cases` | Create 1–100 repository cases (steps go in `custom.custom_steps`) |
| `testmo_update_cases` | Update 1–100 cases by `ids` (same fields applied to all) |

> There is intentionally **no delete tool** — destructive operations are left out
> so the server can't remove data.

## Requirements

- **Node.js 18+** (`node --version`)
- A **Testmo** instance and an **API access key** (Testmo → User Profile → API access)

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/<your-account>/testmo-mcp.git
cd testmo-mcp

# 2. Install dependencies
npm install

# 3. (Optional) verify it starts — Ctrl+C to exit
TESTMO_INSTANCE=https://your-team.testmo.net TESTMO_TOKEN=your-testmo-api-key node index.js
# → prints: [testmo-mcp] ready on stdio
```

Then wire it into your MCP client (below). You don't run the server yourself in
normal use — the client launches it for you.

## Configure your MCP client

Set the environment variables (see `.env.example`) and point your client at
`index.js`. For **Claude Desktop**, edit
`claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`) and add:

```json
{
  "mcpServers": {
    "testmo": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/testmo-mcp/index.js"],
      "env": {
        "TESTMO_INSTANCE": "https://your-team.testmo.net",
        "TESTMO_TOKEN": "your-testmo-api-key"
      }
    }
  }
}
```

Tips:
- Use the **absolute path to `node`** (run `which node`). GUI apps often launch
  with a minimal `PATH` and can't find a bare `node`.
- Fully quit and reopen the client so it re-spawns the server.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `TESTMO_INSTANCE` | yes | Your Testmo URL, e.g. `https://your-team.testmo.net` |
| `TESTMO_TOKEN` | yes | API access key (Testmo → User Profile → API access) |
| `TESTMO_DEFAULT_FOLDER_ID` | no | Default folder for new cases so Testmo doesn't auto-create one each time |

## Notes & gotchas

- **This is a local server.** It only works where it runs. A client session that
  executes in the cloud (not on your machine) can't see it — use it from a local
  session.
- **Testmo has no single "list every test with its name in a run" endpoint.**
  `testmo_list_results` returns tests that have a *recorded result*, and the
  `test_id` it returns is the `run_test_id` you pass to `testmo_record_result`.
- **Linking issue-tracker tickets.** Use the `issues` param on
  `testmo_create_cases` / `testmo_update_cases`. Each item needs `display_id`
  (the ticket ID) and `integration_id` (your Testmo issue integration). Testmo's
  API doesn't list integration IDs, and it can *write* linked issues but not read
  them back. To find your `integration_id`: check the integration in Testmo's
  admin area, or create a throwaway case with `issues:[{display_id:"<id>",
  integration_id:<n>}]` and read the error — Testmo tells you if an integration
  ID "does not exist" or "is not associated with this project," so you can find
  the right one, then delete the throwaway.
- **New cases default to `TESTMO_DEFAULT_FOLDER_ID`** (when set); otherwise Testmo
  auto-creates a folder per create.

## Security

- The token is read from the environment only; it is **never** written to any file
  by this server. `.gitignore` covers `.env`, `node_modules/`, and logs.
- Whoever configures the client stores the token in that client's config — keep it
  private and prefer OS secret storage where available. Rotate the key if it is
  ever exposed.

## License

MIT
