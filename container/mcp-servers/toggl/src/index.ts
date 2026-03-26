/**
 * Toggl Track MCP Server for NanoClaw
 *
 * Provides read/write access to Toggl Track time entries and reports.
 * Auth: HTTP Basic with API token (TOGGL_API_TOKEN env var).
 *
 * Tools:
 *   list_workspaces       — list all workspaces
 *   list_projects         — list projects in a workspace
 *   get_time_entries      — query time entries with date range
 *   get_current_timer     — get the currently running timer (if any)
 *   create_time_entry     — log time (start/stop or duration-based)
 *   stop_timer            — stop the currently running timer
 *   get_summary_report    — grouped summary report for a date range
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Config & HTTP helper
// ---------------------------------------------------------------------------

const API_TOKEN = process.env.TOGGL_API_TOKEN ?? '';
if (!API_TOKEN) {
  process.stderr.write('[toggl-mcp] TOGGL_API_TOKEN not set\n');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${API_TOKEN}:api_token`).toString('base64');

async function togglGet(path: string): Promise<unknown> {
  const url = path.startsWith('http') ? path : `https://api.track.toggl.com${path}`;
  const res = await fetch(url, {
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Toggl API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function togglPost(path: string, body: unknown): Promise<unknown> {
  const url = `https://api.track.toggl.com${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Toggl API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function togglPatch(path: string): Promise<unknown> {
  const url = `https://api.track.toggl.com${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Toggl API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'toggl', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_workspaces',
      description: 'List all Toggl workspaces the user has access to.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_projects',
      description: 'List projects in a Toggl workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'number', description: 'Toggl workspace ID' },
          active: { type: 'boolean', description: 'Filter by active status (default: true)' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'get_time_entries',
      description: 'Get time entries for the current user within a date range.',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'ISO 8601 start date (e.g. 2024-01-01)' },
          end_date: { type: 'string', description: 'ISO 8601 end date (e.g. 2024-01-31)' },
        },
        required: [],
      },
    },
    {
      name: 'get_current_timer',
      description: 'Get the currently running time entry, if any.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'create_time_entry',
      description: 'Log a time entry. Use duration=-1 to start a running timer.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'number', description: 'Toggl workspace ID' },
          description: { type: 'string', description: 'Description of the work' },
          project_id: { type: 'number', description: 'Project ID (optional)' },
          start: { type: 'string', description: 'ISO 8601 start time (e.g. 2024-01-15T09:00:00Z)' },
          duration: {
            type: 'number',
            description: 'Duration in seconds. Use -1 to start a running timer.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags',
          },
        },
        required: ['workspace_id', 'description', 'start', 'duration'],
      },
    },
    {
      name: 'stop_timer',
      description: 'Stop the currently running timer.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'number', description: 'Toggl workspace ID' },
          time_entry_id: { type: 'number', description: 'ID of the running time entry' },
        },
        required: ['workspace_id', 'time_entry_id'],
      },
    },
    {
      name: 'get_summary_report',
      description: 'Get a summary report grouped by project/description for a date range.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'number', description: 'Toggl workspace ID' },
          start_date: { type: 'string', description: 'ISO 8601 start date (e.g. 2024-01-01)' },
          end_date: { type: 'string', description: 'ISO 8601 end date (e.g. 2024-01-31)' },
          grouping: {
            type: 'string',
            enum: ['projects', 'clients', 'users'],
            description: 'How to group the results (default: projects)',
          },
        },
        required: ['workspace_id', 'start_date', 'end_date'],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'list_workspaces': {
        const data = await togglGet('/api/v9/me/all_workspaces');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'list_projects': {
        const wid = a.workspace_id as number;
        const active = a.active !== false;
        const data = await togglGet(
          `/api/v9/workspaces/${wid}/projects?active=${active}`,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_time_entries': {
        const params = new URLSearchParams();
        if (a.start_date) params.set('start_date', a.start_date as string);
        if (a.end_date) params.set('end_date', a.end_date as string);
        const qs = params.toString() ? `?${params}` : '';
        const data = await togglGet(`/api/v9/me/time_entries${qs}`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_current_timer': {
        const data = await togglGet('/api/v9/me/time_entries/current');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'create_time_entry': {
        const wid = a.workspace_id as number;
        const body = {
          description: a.description,
          project_id: a.project_id ?? null,
          start: a.start,
          duration: a.duration,
          tags: a.tags ?? [],
          created_with: 'nanoclaw-mcp',
          workspace_id: wid,
        };
        const data = await togglPost(`/api/v9/workspaces/${wid}/time_entries`, body);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'stop_timer': {
        const wid = a.workspace_id as number;
        const eid = a.time_entry_id as number;
        const data = await togglPatch(`/api/v9/workspaces/${wid}/time_entries/${eid}/stop`);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'get_summary_report': {
        const wid = a.workspace_id as number;
        const body = {
          start_date: a.start_date,
          end_date: a.end_date,
          grouping: a.grouping ?? 'projects',
          sub_grouping: 'entries',
        };
        const data = await togglPost(
          `/reports/api/v3/workspace/${wid}/summary/time_entries`,
          body,
        );
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
