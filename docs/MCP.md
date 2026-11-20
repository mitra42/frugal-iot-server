# Asking Claude about your readings (MCP)

You can connect your own Claude to a Frugal IoT server and ask it about the readings you can
already see on the dashboard. For example:

- "Show me temperature against humidity over the last week."
- "Which nodes went over their maximum last month, and for how long?"
- "Is there enough data to forecast tomorrow's humidity?"

Claude does the thinking on **your own Claude plan**. The server only answers questions about
data, so it costs whoever runs the server nothing beyond reading files. Claude can only read: it
cannot change a setting or send anything to a node.

## What an administrator does

Claude can only see an organization or project where the user has **two** permissions:

- **`MCP`** allows that organization's data to be sent to the user's Claude.
- **`READ`** allows the user to see that data.

Grant both on the dashboard's People card. Granting `MCP` never shows anyone anything they could not
already read.

`READ` and `MCP` granted to everyone apply to every registered user. To stop a user using Claude,
remove their `MCP` permission. Their token keeps existing, but from then on it can read nothing.

## What a user does

1. On the dashboard, open the **Claude** card and make a token. Give it a name that says where it
   will be used, such as `laptop`.
2. Copy the token straight away. It is shown only once, and the server keeps only a hash of it.
3. Connect Claude using one of the two methods below.

The token is like a password: anyone who has it can read what you can. If it might have leaked,
revoke it on the same card and make another.

### Claude Code

The card shows this command, with your token and server already filled in:

```
claude mcp add --scope user --transport http frugal-iot https://<server>/mcp --header "Authorization: Bearer <token>"
```

`--scope user` makes it available in every folder. Without it, Claude Code adds it only for the
folder the terminal is in.

### Claude Desktop

Add this to `claude_desktop_config.json`, then restart Claude Desktop. It uses the `mcp-remote`
bridge, so Node.js must be installed on your computer.

```json
{
  "mcpServers": {
    "frugal-iot": {
      "command": "npx",
      "args": ["mcp-remote", "https://<server>/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer <token>" }
    }
  }
}
```

### claude.ai (web and phone)

These are not supported yet. They need a login flow (OAuth) that the server does not have.

## What Claude can ask

| Tool | What it answers |
| --- | --- |
| `list_scope` | The organizations, projects and nodes you can ask about, and when each node was last heard from. |
| `describe_node` | What a node measures: units, current values, the max and min configured for it, and which days have recorded readings. |
| `get_series` | Readings over a period, either every reading or summarised into buckets of mean, min, max and count. |
| `summarize_field` | One field across many nodes: statistics, and how long each node spent above its configured max or below its configured min. |
| `graph_link` | A link to a chart of the same readings on the server's dashboard (`/dashboard/graph.html`). |

### Chart links

Claude can draw its own charts from the readings. It can also give you a link to a chart on the
server, which you can keep, or send to someone else.

- **The link carries no access of its own.** The page fetches the readings using whoever opens it,
  so it shows only what that person's login may read. Someone who is not logged in is sent to the
  login page and then back to the chart.
- **Anything in the address bar can be changed.** That includes the devices, `from`, `to`,
  `bucket`, `tz` and `title`. `device` takes the same forms as `GET /api/data`.

### Limits on each request

The server refuses a request that would read or return too much, and says what to change, such as
a larger bucket or a shorter period. Claude normally adjusts and asks again. A few requests can run
at once, and each user has an hourly limit.

### What the answers can and cannot tell you

- **"Over its max" uses today's setting.** The server does not keep a history of settings, so it
  compares last month's readings with the max that is set now.
- **"Time over its max" is an estimate.** Each reading is taken to hold until the next one, for at
  most an hour. A node that stops reporting therefore leaves a gap, rather than its last reading
  counting for the whole silence.
- **Times are when the server received a reading**, not when the node measured it.

## For whoever runs the server

- **Where the code is:** `/mcp` is in `lib/mcp.js`. It reads through `lib/data-query.js`, so it
  shares its limits and its concurrency guard with `GET /api/data`.
- **Node thresholds need a newer logger.** `describe_node` and `summarize_field` get each node's
  configured min and max from frugal-iot-logger. A logger that does not yet keep those settings
  still works, but reports no thresholds.
- **Every tool call is logged** to `logs/mcp/<day>.jsonl`. Each line records who called, which tool,
  its arguments, how long it took, how much it read and returned, and the reason if it was refused.
  This is how the tools and the API get improved. It also shows what people have been looking at,
  so the log is protected:
  - It is never served.
  - Its files are readable only by the server's own user.
  - It is deleted after 90 days.

  Read it on the machine, from the server's directory:
  - `npx --no frugal-iot-mcp-log` summarises the last week: calls by tool and user, refusals by
    reason, the slowest calls, and the calls that read far more than they returned.
  - `npx --no frugal-iot-mcp-log 30 raw` lists every call from the last 30 days.

  The `mcplog` setting in `config.d/server.yaml` changes where the log is kept and for how long, or
  turns it off.
- **A browser session is accepted too.** While MCP is being tried out, `/mcp` also accepts a
  logged-in dashboard session as well as a token. That session belongs to the same user, so
  accepting it gives no one anything more. To accept tokens only, set `MCP_ACCEPTS_SESSION` in
  `lib/mcp.js` to `false`.
