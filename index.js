#!/usr/bin/env node
/**
 * Testmo MCP server (local / stdio).
 *
 * Exposes a handful of Testmo REST API operations as MCP tools so a Claude
 * client (Desktop, Code, etc.) can read projects/runs/results and create or
 * update runs, results and cases. Auth + instance come from environment
 * variables:
 *
 *   TESTMO_INSTANCE   e.g. https://your-team.testmo.net   (no trailing slash)
 *   TESTMO_TOKEN      a Testmo API access key
 *
 * The token is never written to disk by this server — it is read from the
 * environment the client launches it with.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const INSTANCE = (process.env.TESTMO_INSTANCE || "").replace(/\/+$/, "");
const TOKEN = process.env.TESTMO_TOKEN || "";

if (!INSTANCE || !TOKEN) {
  console.error(
    "[testmo-mcp] Missing config. Set TESTMO_INSTANCE (e.g. https://your-team.testmo.net) and TESTMO_TOKEN."
  );
  process.exit(1);
}

// Optional default folder for new cases when a create call omits folder_id.
// Set TESTMO_DEFAULT_FOLDER_ID to a folder ID to stop Testmo auto-creating a
// fresh folder on every create. Unset (or 0) = let Testmo decide.
const rawDefaultFolder = process.env.TESTMO_DEFAULT_FOLDER_ID ?? "";
const DEFAULT_FOLDER_ID =
  /^\d+$/.test(rawDefaultFolder) && Number(rawDefaultFolder) > 0
    ? Number(rawDefaultFolder)
    : null;

/**
 * Call the Testmo REST API. `path` is everything after /api/v1
 * (e.g. "/projects" or "/runs/1/results"). Returns parsed JSON.
 * Throws on non-2xx with the response body included.
 */
async function testmo(method, path, { query, body } = {}) {
  let url = `${INSTANCE}/api/v1${path}`;
  if (query && Object.keys(query).length) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") usp.append(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    const msg =
      typeof data === "object" && data && data.message
        ? data.message
        : raw || res.statusText;
    throw new Error(`Testmo ${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return data;
}

/** Wrap a handler so thrown errors become clean MCP tool errors. */
function tool(fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  };
}

const server = new McpServer({ name: "testmo", version: "1.0.0" });

server.tool(
  "testmo_list_projects",
  "List all Testmo projects (id, name, run/milestone counts).",
  {},
  tool(async () => testmo("GET", "/projects"))
);

server.tool(
  "testmo_list_runs",
  "List manual test runs for a project. Supports optional name filter, open/closed filter, milestone filter and pagination.",
  {
    project_id: z.number().int().describe("Project ID"),
    name: z.string().optional().describe("Filter runs by name (partial match)"),
    is_closed: z
      .boolean()
      .optional()
      .describe("true = closed runs only, false = active only"),
    milestone_id: z.number().int().optional().describe("Filter by milestone ID"),
    page: z.number().int().optional().describe("Page number (default 1)"),
    per_page: z
      .number()
      .int()
      .optional()
      .describe("Rows per page: 15, 25, 50, or 100 (default 100)"),
  },
  tool(async ({ project_id, ...q }) =>
    testmo("GET", `/projects/${project_id}/runs`, { query: q })
  )
);

server.tool(
  "testmo_get_run",
  "Get a single run's summary (name, status counts, totals, milestone).",
  {
    run_id: z.number().int().describe("Run ID"),
    expands: z
      .string()
      .optional()
      .describe("Comma-separated expands: milestones,states,statuses,users"),
  },
  tool(async ({ run_id, expands }) =>
    testmo("GET", `/runs/${run_id}`, { query: { expands } })
  )
);

server.tool(
  "testmo_list_results",
  "List recorded test results for a run. Note: this returns tests that have a recorded result, not necessarily every case in the run. The per-result `test_id` is the run_test_id needed to record a new result.",
  {
    run_id: z.number().int().describe("Run ID"),
    status_id: z
      .string()
      .optional()
      .describe("Comma-separated status IDs to filter by"),
    case_id: z.string().optional().describe("Filter by case ID(s)"),
    get_latest_result: z
      .boolean()
      .optional()
      .describe("true = only the most recent result per test"),
    page: z.number().int().optional().describe("Page number (default 1)"),
    per_page: z
      .number()
      .int()
      .optional()
      .describe("Rows per page: 15, 25, 50, or 100 (default 100)"),
    expands: z
      .string()
      .optional()
      .describe("Comma-separated expands: issues,users"),
  },
  tool(async ({ run_id, ...q }) =>
    testmo("GET", `/runs/${run_id}/results`, { query: q })
  )
);

server.tool(
  "testmo_list_statuses",
  "List the result statuses for a project (id → name, e.g. Passed/Failed/Blocked). Needed to know which status_id to use when recording a result.",
  {
    project_id: z.number().int().describe("Project ID"),
  },
  tool(async ({ project_id }) => testmo("GET", `/projects/${project_id}/statuses`))
);

server.tool(
  "testmo_record_result",
  "Record a result for one test in a run. `run_test_id` is the test's per-run id (shown as `test_id` in testmo_list_results). Get valid status IDs from testmo_list_statuses.",
  {
    run_id: z.number().int().describe("Run ID"),
    run_test_id: z
      .number()
      .int()
      .describe("Per-run test id (the `test_id` field from testmo_list_results)"),
    status_id: z
      .number()
      .int()
      .describe("Status to assign (from testmo_list_statuses)"),
    comment: z.string().optional().describe("Optional comment / note"),
    elapsed: z
      .number()
      .int()
      .optional()
      .describe("Optional elapsed time in milliseconds"),
  },
  tool(async ({ run_id, run_test_id, ...body }) =>
    testmo("POST", `/runs/${run_id}/tests/${run_test_id}/results`, { body })
  )
);

server.tool(
  "testmo_get",
  "Escape hatch: perform a raw GET against any Testmo API path (everything after /api/v1). Use for endpoints not covered by the other tools.",
  {
    path: z
      .string()
      .describe("API path after /api/v1, e.g. '/milestones/1' or '/projects/1'"),
  },
  tool(async ({ path }) =>
    testmo("GET", path.startsWith("/") ? path : `/${path}`)
  )
);

/* ------------------------------------------------------------------ *
 * Read helpers that the write tools depend on (to look up IDs).       *
 * ------------------------------------------------------------------ */

server.tool(
  "testmo_list_states",
  "List workflow states for a project (run, repository_case, session). Needed for state_id when creating a run or a case.",
  {
    project_id: z.number().int().describe("Project ID"),
  },
  tool(async ({ project_id }) => testmo("GET", `/projects/${project_id}/states`))
);

server.tool(
  "testmo_list_templates",
  "List case templates for a project. Needed for template_id when creating cases (and to know which custom_* fields a template accepts).",
  {
    project_id: z.number().int().describe("Project ID"),
  },
  tool(async ({ project_id }) =>
    testmo("GET", `/projects/${project_id}/templates`)
  )
);

server.tool(
  "testmo_list_cases",
  "List test cases in a project's repository. Supports folder/name/template filters and pagination.",
  {
    project_id: z.number().int().describe("Project ID"),
    folder_id: z.number().int().optional().describe("Filter by folder ID"),
    recursive: z
      .boolean()
      .optional()
      .describe("Include sub-folders of folder_id"),
    name: z.string().optional().describe("Filter by name (partial match)"),
    template_id: z.number().int().optional().describe("Filter by template ID"),
    page: z.number().int().optional().describe("Page number (default 1)"),
    per_page: z
      .number()
      .int()
      .optional()
      .describe("Rows per page: 15, 25, 50, or 100 (default 100)"),
  },
  tool(async ({ project_id, ...q }) =>
    testmo("GET", `/projects/${project_id}/cases`, { query: q })
  )
);

/* ------------------------------------------------------------------ *
 * Write tools (create/update — no delete).                            *
 * ------------------------------------------------------------------ */

server.tool(
  "testmo_create_run",
  "Create a new manual test run in a project. Requires name, state_id (from testmo_list_states, entity 'run') and include_all. When include_all is false you must pass `cases` (array of case IDs).",
  {
    project_id: z.number().int().describe("Project ID"),
    name: z.string().describe("Run name"),
    state_id: z
      .number()
      .int()
      .describe("Workflow state ID for the run (entity 'run')"),
    include_all: z
      .boolean()
      .describe("true = include all project cases; false = use `cases`"),
    cases: z
      .array(z.number().int())
      .optional()
      .describe("Case IDs to include (required when include_all is false)"),
    milestone_id: z.number().int().optional().describe("Milestone ID"),
    config_id: z.number().int().optional().describe("Configuration ID"),
    origin_id: z
      .number()
      .int()
      .optional()
      .describe("Existing run ID to clone cases from"),
    note: z.string().optional().describe("Short note (max 80 chars)"),
    docs: z.string().optional().describe("Description / body text"),
    tags: z.array(z.string()).optional().describe("Tag strings"),
    assign: z
      .boolean()
      .optional()
      .describe("Assign the run's tests to the creating user"),
  },
  tool(async ({ project_id, ...body }) =>
    testmo("POST", `/projects/${project_id}/runs`, { body })
  )
);

server.tool(
  "testmo_update_run",
  "Update a run (PATCH). Only provided fields change. Set is_closed=true to close a run (runs cannot be re-opened via the API; false is rejected).",
  {
    run_id: z.number().int().describe("Run ID"),
    name: z.string().optional().describe("New run name"),
    state_id: z.number().int().optional().describe("New workflow state ID"),
    milestone_id: z.number().int().optional().describe("Milestone ID"),
    config_id: z.number().int().optional().describe("Configuration ID"),
    include_all: z
      .boolean()
      .optional()
      .describe("Whether the run includes all project cases"),
    note: z.string().optional().describe("Short note (max 80 chars)"),
    docs: z.string().optional().describe("Description / body text"),
    tags: z.array(z.string()).optional().describe("Tag strings"),
    is_closed: z
      .boolean()
      .optional()
      .describe("true = close the run (cannot be re-opened)"),
  },
  tool(async ({ run_id, ...body }) => testmo("PATCH", `/runs/${run_id}`, { body }))
);

server.tool(
  "testmo_record_results_bulk",
  "Record results for multiple tests in a run in one request (1-100). Each item needs test_id (the per-run test id from testmo_list_results) and status_id. All items are validated before any are written — an invalid item rejects the whole batch.",
  {
    run_id: z.number().int().describe("Run ID"),
    results: z
      .array(
        z.object({
          test_id: z
            .number()
            .int()
            .describe("Per-run test id (from testmo_list_results)"),
          status_id: z.number().int().describe("Status ID to assign"),
          comment: z.string().optional().describe("Optional comment"),
          elapsed: z
            .number()
            .int()
            .optional()
            .describe("Optional elapsed time in ms"),
          assignee_id: z
            .number()
            .int()
            .optional()
            .describe("Optional assignee user ID"),
        })
      )
      .min(1)
      .max(100)
      .describe("1-100 result items"),
  },
  tool(async ({ run_id, results }) =>
    testmo("POST", `/runs/${run_id}/tests/results/bulk`, { body: { results } })
  )
);

server.tool(
  "testmo_create_cases",
  "Create one or more test cases (1-100) in a project's repository. Each case needs a name; folder_id/template_id/state_id are optional (defaults used). Steps and other template-specific fields go in `custom` with keys like `custom_steps`, `custom_priority` (must match the template or you get a 422).",
  {
    project_id: z.number().int().describe("Project ID"),
    cases: z
      .array(
        z.object({
          name: z.string().describe("Case name (required)"),
          folder_id: z
            .number()
            .int()
            .optional()
            .describe(
              "Folder ID. If omitted, falls back to TESTMO_DEFAULT_FOLDER_ID when set; otherwise Testmo auto-creates a folder."
            ),
          template_id: z
            .number()
            .int()
            .optional()
            .describe("Template ID (project default if omitted)"),
          state_id: z.number().int().optional().describe("Case state ID"),
          estimate: z
            .number()
            .int()
            .optional()
            .describe("Estimated duration in seconds"),
          tags: z.array(z.string()).optional().describe("Tag strings"),
          issues: z
            .array(
              z.object({
                display_id: z
                  .union([z.string(), z.number()])
                  .describe("Ticket ID in your tracker (e.g. 1234)"),
                integration_id: z
                  .number()
                  .int()
                  .describe(
                    "Testmo issue-integration ID for your tracker (see README: 'Linking issue-tracker tickets')"
                  ),
                connection_project_id: z
                  .number()
                  .int()
                  .optional()
                  .describe("Optional; used by some trackers (GitHub/GitLab)"),
              })
            )
            .optional()
            .describe(
              "Link issue-tracker tickets. Each item needs display_id + integration_id."
            ),
          custom: z
            .record(z.any())
            .optional()
            .describe(
              'Template custom fields, keys prefixed custom_ e.g. {"custom_steps":[{"text1":"<p>Do X</p>","text3":"<p>Expect Y</p>"}],"custom_priority":1}'
            ),
        })
      )
      .min(1)
      .max(100)
      .describe("1-100 case objects"),
  },
  tool(async ({ project_id, cases }) => {
    const payload = cases.map(({ custom, ...rest }) => {
      const caseObj = { ...rest, ...(custom || {}) };
      if (caseObj.folder_id === undefined && DEFAULT_FOLDER_ID) {
        caseObj.folder_id = DEFAULT_FOLDER_ID;
      }
      return caseObj;
    });
    return testmo("POST", `/projects/${project_id}/cases`, {
      body: { cases: payload },
    });
  })
);

server.tool(
  "testmo_update_cases",
  "Update 1-100 repository cases (PATCH). Pass `ids` (the cases to change) plus the fields to apply to ALL of them — the same values are written to every listed case (so name is normally used with a single id). Template custom fields go in `custom` (e.g. custom_steps, custom_priority) and must exist in every targeted case's template.",
  {
    project_id: z.number().int().describe("Project ID"),
    ids: z
      .array(z.number().int())
      .min(1)
      .max(100)
      .describe("Case IDs to update (1-100)"),
    name: z.string().optional().describe("New name for the case(s)"),
    folder_id: z
      .number()
      .int()
      .optional()
      .describe("Move case(s) to this folder ID"),
    state_id: z.number().int().optional().describe("New case state ID"),
    status_id: z.number().int().optional().describe("New case status ID"),
    estimate: z
      .number()
      .int()
      .optional()
      .describe("Estimated duration in seconds"),
    tags: z.array(z.string()).optional().describe("Tag strings"),
    issues: z
      .array(
        z.object({
          display_id: z
            .union([z.string(), z.number()])
            .describe("Ticket ID in your tracker (e.g. 1234)"),
          integration_id: z
            .number()
            .int()
            .describe(
              "Testmo issue-integration ID for your tracker (see README: 'Linking issue-tracker tickets')"
            ),
          connection_project_id: z
            .number()
            .int()
            .optional()
            .describe("Optional; used by some trackers (GitHub/GitLab)"),
        })
      )
      .optional()
      .describe(
        "Link issue-tracker tickets. Each item needs display_id + integration_id."
      ),
    custom: z
      .record(z.any())
      .optional()
      .describe(
        'Template custom fields, keys prefixed custom_ e.g. {"custom_steps":[{"text1":"<p>Do X</p>","text3":"<p>Expect Y</p>"}],"custom_priority":2}'
      ),
  },
  tool(async ({ project_id, custom, ...rest }) =>
    testmo("PATCH", `/projects/${project_id}/cases`, {
      body: { ...rest, ...(custom || {}) },
    })
  )
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[testmo-mcp] ready on stdio");
