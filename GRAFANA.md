# Charting your readings in Grafana

The server can hand Grafana an organization's readings directly, from the same CSV files the logger
writes. Nothing is copied into a second database, so Grafana sees the **complete** history of every
topic, not just what was exported somewhere.

Grafana reads it with its free **Infinity** data source plugin, which can call any URL that returns
JSON. Nothing has to be installed on the server for this beyond Frugal IoT itself.

> **Status:** followed against Grafana 13.3 with Infinity 4.1.5 (a Mac, Homebrew install): the data
> source, the query and the starter dashboard below all work. Not yet tried on a Linux server, or from
> the Grafana UI by hand - the steps in section 3 were applied through Grafana's API with the same
> settings, so button labels may differ slightly from what you see.

Installing Grafana itself, on a Mac or a Linux server, is in [INSTALL-OPENSEARCH.md](INSTALL-OPENSEARCH.md).

## 1. Make a token

A token lets Grafana read **one organization**, read-only, and nothing else. Run this in the server's
directory (the one with `frugal-iot.db`):

```sh
npx --no frugal-iot-grafana-token add <org> <name>      # e.g.  add dev my-grafana
npx --no frugal-iot-grafana-token list <org>
npx --no frugal-iot-grafana-token revoke <org> <name>
```

The token starts `fiot_` and is printed **once** - only a hash is kept, so a copy of the database
does not hand out working credentials. If it is lost, run `add` again with the same name: that
replaces it. Use a different name for each Grafana, so one can be revoked without disturbing another.

(An administrator can also issue tokens over HTTP, `POST /grafana_token/<org>` with `{"name": "..."}`
while logged in. The dashboard has no page for this yet.)

## 2. What Grafana can call

All of these need the header `Authorization: Bearer fiot_...`, and the token must be for the `<org>` in
the URL.

| URL | Returns |
|---|---|
| `/grafana/<org>/health` | `{"status":"ok"}` - for Grafana's "Save & test" |
| `/grafana/<org>/topics` | every topic with readings: `[{topic, project, node, module, leaf}]`. Narrow with `?project=` and `?node=` |
| `/grafana/<org>/data?topic=<topic>&from=<time>&to=<time>&maxPoints=<n>` | `[{"time": "2026-09-24T00:00:01.000Z", "value": 22.5}, ...]` |

- `topic` is the full topic, `<org>/<project>/<node>/<module>/<leaf>`, e.g.
  `dev/lotus/esp32-944104/aht20/temperature`.
- `from` and `to` are epoch **milliseconds** (which is what Grafana's `${__from}` and `${__to}` give), or an
  ISO date. Without them you get the last 24 hours.
- Past `maxPoints` (default 1000, at most 5000) readings are averaged into equal time buckets, so a
  year of data does not travel as millions of rows.
- Readings that are not numbers (descriptions, colours) are left out - they cannot be charted.

Quick check from a terminal:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-server/grafana/dev/data?topic=dev/lotus/esp32-944104/aht20/temperature&from=2026-09-01T00:00:00Z"
```

## 3. Point Grafana at it (Infinity data source)

1. In Grafana, install the **Infinity** plugin (Administration → Plugins → search "Infinity"), and
   restart Grafana. (Homebrew's Grafana has no plugin button that works from the shell; use
   `grafana cli --homepath /opt/homebrew/opt/grafana/share/grafana --pluginsDir /opt/homebrew/var/lib/grafana/plugins plugins install yesoreyeram-infinity-datasource`.)
2. Add a data source of type Infinity. Authentication: **Bearer Token**, with the `fiot_...` token.
   Under *Allowed hosts* add your server's URL, e.g. `https://frugaliot.naturalinnovation.org`.
3. In a panel, choose that data source, then Type **JSON**, Parser **Backend**, Format **Time series**:
   - URL: `https://your-server/grafana/dev/data?topic=dev/lotus/esp32-944104/aht20/temperature&from=${__from}&to=${__to}&maxPoints=1000`
   - Columns: `time` → *Timestamp*, `value` → *Number*.

`${__from}` and `${__to}` are Grafana's own, filled in from the time range at the top of the dashboard.
Use a fixed `maxPoints`; Grafana has no macro for the panel's width in pixels, and `${__interval_ms}`
is a duration, not a count.

### The starter dashboard

[extras/grafana/frugaliot-readings.json](extras/grafana/frugaliot-readings.json) is a ready-made
dashboard with one chart and a **Topic** box to type any topic into. Import it with Dashboards → New →
Import → upload the file. It asks for three things: the Infinity data source to use (one per
organization, each holding that organization's token), the server's URL, and the organization.

Import it again for another organization, choosing that organization's data source.

To pick from a list instead of typing, `GET /grafana/<org>/topics` returns every topic; an Infinity
query variable over that URL can feed a dropdown. The starter dashboard does not do this yet.

## Notes

- Each organization needs its own token and its own data source in Grafana, which is what keeps one
  organization's readings away from another's.
- Readings are written to disk every few minutes, so the endpoint first asks the logger to write out
  what it holds; a chart that reaches "now" is not short.
- The CSV archive can contain a sensor's error value (an SHT sensor reports -45 or 130 when it fails).
  They are real readings as far as the logger knows, so they appear on charts; set the panel's axis
  limits, or filter in Grafana, to leave them out.
