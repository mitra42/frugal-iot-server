# Installing OpenSearch, Dashboards and Grafana

This is for **browsing and charting your readings**. It is optional - the server and logger work
without any of it, and the readings are always safe in the CSV files under `data/`.

There are two separate ways to chart, and you can use either or both:

| | Gets its data from | Sees | Needs |
|---|---|---|---|
| **Grafana** | the server directly, over HTTP ([GRAFANA.md](GRAFANA.md)) | the complete history of every organization | Grafana + the Infinity plugin |
| **OpenSearch Dashboards** (or Grafana's OpenSearch source) | OpenSearch, which the logger forwards readings to | only what has been forwarded, so only organizations that have the forwarder switched on | OpenSearch + Dashboards |

If all you want is charts, **Grafana alone is enough** - skip OpenSearch. OpenSearch earns its place
for searching and slicing readings in ways a chart-per-topic cannot, and for organizations that want
Kibana-style tools.

We use **OpenSearch**, not Elasticsearch: it is Apache-licensed, installs with Homebrew and apt, and
Grafana can read it. OpenSearch Dashboards is its fork of Kibana, so Kibana guides are close but not
identical. (The reasoning is also in a comment above the `OpenSearch` class in frugal-iot-logger's
`index.js`, in case the decision is revisited.)

**Not for the Raspberry Pi bridge.** OpenSearch is a Java program that wants a gigabyte or more of
memory for itself. Put it on your Mac for trying things out, and on the production server.

> **Status:** the Mac steps were followed on macOS with Homebrew (OpenSearch 3.9.0, Dashboards 3.9.0,
> Grafana 13.3.0). The Linux steps are taken from OpenSearch's and Grafana's own installation guides
> and have **not yet been run on a Linux server** - correct them where they differ, and say so under
> [Open questions](#open-questions).

---

## On a Mac (to try it out)

```sh
brew install opensearch opensearch-dashboards grafana
```

Each is large, so do them one at a time on slow WiFi.

### OpenSearch

```sh
brew services start opensearch
curl http://localhost:9200          # should print a block of JSON with "cluster_name"
```

Homebrew's OpenSearch has **no security plugin**: it listens on `http://localhost:9200` with no login,
and only your own machine can reach it. That is fine for trying things out and is not how the Linux
install below behaves.

### Dashboards

Dashboards will not start until a folder exists that Homebrew forgot to create:

```sh
mkdir -p /opt/homebrew/var/run
brew services start opensearch-dashboards
```

(Without it the service shows `error 1` in `brew services list`, and the log
`/opt/homebrew/var/log/opensearch-dashboards.log` says it cannot open `opensearchDashboards.pid`.)
Then open <http://localhost:5601>. The first start takes a minute or two.

### Grafana

```sh
brew services start grafana
```

Open <http://localhost:3000>. Grafana's own default login is `admin` / `admin`, and it asks you to
change it. Then add the Infinity plugin and restart Grafana:

```sh
/opt/homebrew/opt/grafana/bin/grafana cli --homepath /opt/homebrew/opt/grafana/share/grafana \
  --pluginsDir /opt/homebrew/var/lib/grafana/plugins plugins install yesoreyeram-infinity-datasource
brew services restart grafana
```

Continue at [GRAFANA.md](GRAFANA.md) to make a token and connect it to your server.

### Stopping them again

```sh
brew services stop grafana opensearch-dashboards opensearch
```

Homebrew restarts them at login until you do.

---

## On the production server (Debian / Ubuntu)

### OpenSearch

```sh
sudo apt-get update && sudo apt-get -y install lsb-release ca-certificates curl gnupg2
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://artifacts.opensearch.org/publickeys/opensearch-release.pgp \
  | sudo gpg --dearmor -o /etc/apt/keyrings/opensearch.gpg
```

Then add OpenSearch's apt repository (the `3.x/apt` line from
[their Debian guide](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/debian/),
which is printed there for your architecture) and install, choosing an admin password now:

```sh
sudo apt-get update
sudo env OPENSEARCH_INITIAL_ADMIN_PASSWORD='<choose-a-strong-password>' apt-get install opensearch
sudo systemctl enable opensearch
sudo systemctl start opensearch
curl https://localhost:9200 -u 'admin:<that password>' --insecure
```

Unlike Homebrew's, this install **has the security plugin switched on**: HTTPS, a login, and a
self-signed certificate (hence `--insecure`, which here just means "do not check it"). The password
is only used to set up that demo security configuration. Config is in `/etc/opensearch/opensearch.yml`
and the memory setting in `/etc/opensearch/jvm.options`.

- **Memory:** the file ships with `-Xms1g` and `-Xmx1g` (a 1 GB heap). Give both lines the same value;
  more helps with a lot of history, and the machine needs that much free *beyond* what the server,
  broker and logger use. The data is small: all 598,000 readings of the `dev` organization came to
  about 35 MB.
- **If it will not start**, look at `journalctl -u opensearch`. A common cause on Linux is the kernel
  setting `vm.max_map_count` being below 262144; `sudo sysctl -w vm.max_map_count=262144` fixes it until
  reboot, and a line in `/etc/sysctl.d/` makes it permanent.
- **Do not open port 9200 to the internet.** The demo certificate and the password are not a basis
  for that. Leave it listening on the machine itself, which is all the logger and Grafana need.

### Tell the logger to send to it

Easiest: in the dashboard, open the project's back, then the **Forwarders** card, and add an
OpenSearch forwarder. It applies at once, with no restart. Or, in the organization's file under
`config.d/organizations/` (which only whoever runs the server can edit, and where the settings the
card does not offer - such as a CA certificate file - live):

```yaml
forwarders:
  - type: opensearch
    node: https://localhost:9200
    username: admin
    password: <the password you chose>
    insecure: true        # the certificate is self-signed - fine for a connection that never leaves this machine
    topics:               # optional - leave out to send everything that is logged
      - dev/lotus/#
```

The full list of settings is in frugal-iot-logger's README. Restart the server. The forwarder creates
what it needs (an index template that makes `value` a number) the first time it starts.

> Using the `admin` account for this is the simplest thing that works, not the best: it can do
> anything in OpenSearch. A role that can only write `frugaliot-*` indices would be better, and is
> not yet written.

### Loading the history you already have

The forwarder only sends readings from the moment it starts. To bring in everything already on disk
(safe to repeat, and safe while the logger is running):

```sh
node node_modules/frugal-iot-logger/scripts/backfill-opensearch.js --config . --org dev --data data
```

Add `--dry-run` first to see how many readings it would send.

### OpenSearch Dashboards

Dashboards is a separate package from OpenSearch, installed from
[its own guide](https://docs.opensearch.org/latest/install-and-configure/install-dashboards/debian/).
It listens on port 5601, and has to be told OpenSearch's address and the `admin` password in
`/etc/opensearch-dashboards/opensearch_dashboards.yml`. Then, in Dashboards: **Dashboards Management →
Index patterns → Create**, enter `frugaliot-*`, and choose `@timestamp` as the time field.

Do not expose 5601 to the internet either, without HTTPS in front of it.

### Grafana

```sh
sudo apt-get install -y apt-transport-https wget gnupg
sudo mkdir -p /etc/apt/keyrings
sudo wget -O /etc/apt/keyrings/grafana.asc https://apt.grafana.com/gpg-full.key
sudo chmod 644 /etc/apt/keyrings/grafana.asc
echo "deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main" \
  | sudo tee -a /etc/apt/sources.list.d/grafana.list
sudo apt-get update
sudo apt-get install grafana
sudo systemctl daemon-reload
sudo systemctl enable grafana-server
sudo systemctl start grafana-server
sudo grafana cli plugins install yesoreyeram-infinity-datasource
sudo systemctl restart grafana-server
```

It listens on port 3000, with Grafana's default login `admin` / `admin`, which it asks you to change.
Continue at [GRAFANA.md](GRAFANA.md). Because Grafana is on the same machine as the server, its
data source can use `http://localhost:8080` and nothing has to be exposed for it.

---

## Looking after it

- **Old months.** Readings go into one index per organization per month, named like
  `frugaliot-dev-2026.09`. To drop a month: `curl -X DELETE http://localhost:9200/frugaliot-dev-2026.02`
  (add `-u admin:... --insecure` and `https` on the Linux install). The CSV files are untouched.
- **A gap while OpenSearch was down.** The forwarder does not retry a batch it could not send; the
  CSV files have everything, and the backfill above fills the gap.
- **Starting afresh.** Deleting the indices (`frugaliot-*`) and running the backfill again rebuilds
  everything from the CSV files.

## Open questions

Please add what you find:

- The Linux steps above have not been run. In particular: the exact `apt` repository line, whether
  OpenSearch Dashboards is in the same repository, and the Dashboards configuration.
- A write-only OpenSearch role for the logger, in place of `admin`.
- Whether Grafana should reach the server over `http://localhost:8080` or the public URL on the
  production machine.
