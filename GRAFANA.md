# Charting your readings in Grafana

Grafana can chart an organization's readings straight from this server, from the same CSV files the
logger writes. Nothing is copied into a second database, so Grafana sees the **complete** history of
every topic, not just what was exported somewhere.

It needs nothing extra on the server, and Grafana can run **on your own computer**: all it asks of the
server is ordinary HTTPS on the port the dashboard already uses, with a token you make for it. (To
run Grafana on the server instead, see [INSTALL-OPENSEARCH.md](INSTALL-OPENSEARCH.md).)

Grafana reads the server with its free **Infinity** plugin, which can call any URL that returns JSON.

> **Status:** the server, the data source, the starter dashboard and its topic list were followed on
> Grafana 13.3 with Infinity 4.1.5 (a Mac, Homebrew install), and the dashboard was loaded in a
> browser to confirm it draws real readings. Two things are written but not yet tried against a real
> Grafana: the downloadable data source file (it holds the same settings that worked when set through
> Grafana's API), and the Grafana card on the dashboard clicked through by hand. Correct this page
> where they differ.

## Installing

#### On a Mac, 

```sh
brew install grafana
brew services start grafana
```

Open <http://localhost:3000>. Grafana's default login is `admin` / `admin`, and it asks you to change it.
Then add the Infinity plugin - in Grafana, Administration → Plugins → "Infinity" - or from the shell:

```sh
/opt/homebrew/opt/grafana/bin/grafana cli --homepath /opt/homebrew/opt/grafana/share/grafana \
  --pluginsDir /opt/homebrew/var/lib/grafana/plugins plugins install yesoreyeram-infinity-datasource
brew services restart grafana
```
To stop it: `brew services stop grafana` (Homebrew restarts it at login until you do).

#### On Windows, Linux and other systems

For other systems, Grafana's own download page has installers for [Windows, Linux and others](https://grafana.com/grafana/download).

## Setting it up
Access Grafana from your browser at [localhost:3000](http://localhost:3000)

Anyone who can **read** the organization can make a token for themselves - you do not need to be an
administrator. A token is yours: Grafana sees what *you* can see, so a token made by someone who can
read only one project shows that project only.

1. **Install the Infinity plugin in Grafana.** In Grafana: Administration → Plugins, search for
   "Infinity", install it, and restart Grafana if it asks. (Installing Grafana itself is in
   [INSTALL-OPENSEARCH.md](INSTALL-OPENSEARCH.md).)
2. **Make a token.** In the Frugal IoT dashboard, open the project's back, then the **Grafana** card. Type a name
   for this Grafana (so it can be revoked on its own later) and press *Make a token*. The token is shown
   **once** - only a hash is kept, so it cannot be looked up again. If you lose it, make one with the
   same name, which replaces it.
3. **Give Grafana the data source.** Either:
   a: press *Download the data source file* in the same place and
   put it in Grafana's `provisioning/datasources` folder (On a Mac typically in /opt/homebrew/Cellar/grafana/13.3.0/share/grafana/conf/provisioning),
   then restart Grafana:
   - On Mac: `brew services restart grafana`;
   
   or add it by hand in
   Grafana under Connections → Data sources → Add → **Infinity**:
   - Authentication: **Bearer Token**, with the token
   - Allowed hosts: the address you reached this dashboard at, e.g. `https://frugaliot.naturalinnovation.org`
4. **Import the dashboard.** 
  * On FrugalIoT: In the Grafana card press *Download the dashboard*. 
  * Then in Grafana choose
    Dashboards → New → Import, upload the file, and pick the data source from step 3 when it asks.

The dashboard has a list of every topic at the top to choose from, and the time range at the top right.
The file already has this server and organization filled in.

A token lets one Grafana read **one organization**, read-only - and only the
projects of it that the person who made the token may read. For another
organization, make its own token, data source and import - the dashboard file is separate for each, so
importing a second does not replace the first. *Revoke* on the card cuts off a Grafana at once.

## What the server provides

For building your own panels. All of these need the header `Authorization: Bearer fiot_...`, and the
token must be for the `<org>` in the URL.

| URL | Returns |
|---|---|
| `/grafana/<org>/health` | `{"status":"ok"}` |
| `/grafana/<org>/topics` | every topic with readings: `[{topic, project, node, module, leaf}]`. Narrow with `?project=` and `?node=` |
| `/grafana/<org>/data?topic=<topic>&from=<time>&to=<time>&maxPoints=<n>` | `[{"time": "2026-09-24T00:00:01.000Z", "value": 22.5}, ...]` |

- `topic` is the full topic, `<org>/<project>/<node>/<module>/<leaf>`, e.g.
  `dev/lotus/esp32-944104/aht20/temperature`.
- `from` and `to` are epoch **milliseconds** (which is what Grafana's `${__from}` and `${__to}` give), or
  an ISO date. Without them you get the last 24 hours.
- Past `maxPoints` (default 1000, at most 5000) readings are averaged into equal time buckets, so a year
  of data does not travel as millions of rows.
- Readings that are not numbers (descriptions, colours) are left out - they cannot be charted.

A panel in Grafana, using the Infinity data source: Type **JSON**, Parser **Backend**, Format **Time
series**, URL

```
https://your-server/grafana/dev/data?topic=dev/lotus/esp32-944104/aht20/temperature&from=${__from}&to=${__to}&maxPoints=1000
```

and columns `time` → *Timestamp*, `value` → *Number*. Use a fixed `maxPoints`: Grafana has no macro for a
panel's width in pixels, and `${__interval_ms}` is a duration, not a count.

## Keeping it safe

- **A token is a password.** Anyone holding it can read what its maker can read, and the data
  source file the card offers has it inside, so do not leave that file lying about or send it by mail.
  The server cannot show a token again, only replace it.
- It is **read-only and for one organization**. It cannot change anything, and the server refuses it for
  any other organization.
- It **acts as the person who made it**, and is checked against their permissions every time it is
  used. If their access to the organization or a project is removed, the token loses it at once - there
  is nothing to revoke. Someone cannot use a token to see more than they could on the dashboard.
- You see and revoke your own tokens. An administrator of the whole organization sees everyone's and
  can revoke any, for example when a Grafana is lost.
- **Revoke** on the card cuts a Grafana off at once. Make one token per Grafana, named for it, so one
  can go without disturbing the rest, and revoke any that is no longer used - the card shows when each
  was last used. Tokens do not expire on their own.
- Grafana should reach the server over **HTTPS**, since the token travels in a header.
- On a Grafana that other people use, give **each organization its own Grafana organization**, with its
  own data source and token: everyone in a Grafana organization shares its data sources, so anyone who
  can edit a dashboard there can read whatever the token allows.
- The server limits what a token can cost it: long histories are averaged as they are read, only a few
  reads run at once - and only two for any one organization - (Grafana is told to retry), and the topic
  list is cached for a minute. Each user can hold up to 10 tokens per organization.

## From a shell instead

If you can get to the server's directory, `npx --no frugal-iot-grafana-token add <org> <username> <name>` makes a
token for that user, and `list` and `revoke` do what they say. It is the same as the card, except you name whose token it is.

## Notes

- Readings are written to disk every few minutes, so the server first asks the logger to write out what
  it holds; a chart that reaches "now" is not short.
- The CSV files can contain a sensor's error value (an SHT sensor reports -45 or 130 when it fails).
  They are real readings as far as the logger knows, so they appear on charts; set the panel's axis
  limits, or filter in Grafana, to leave them out.
- The first topic in the list is simply the first alphabetically, and may be a sensor that has stopped,
  which shows "No data" for a recent time range. Pick another.
