# Installing OpenSearch, Grafana and Dashboards

This is for **browsing and charting your readings**. All of it is optional - the server and logger work
without any of it, and the readings are always safe in the CSV files under `data/`.

## What goes where

There are two separate ways to chart, and they need different things in different places:

| Piece | What it is | Where it goes |
|---|---|---|
| **OpenSearch** | a search database the logger forwards readings to | **the server**, and only the server |
| **Grafana** | charts - reads the server directly ([GRAFANA.md](GRAFANA.md)), or OpenSearch | **your own computer** (recommended), or the server |
| **OpenSearch Dashboards** | OpenSearch's own browser for searching and charting | your computer or the server - but it must be able to reach OpenSearch |

The simplest setup, and the one to start with: **Grafana on your own computer, reading the server
directly.** It needs no OpenSearch at all, sees every reading ever recorded, and asks nothing of the
server except the HTTPS it already serves. Nothing new is exposed to the internet.

Add **OpenSearch on the server** when you want to search and slice readings in ways a chart per topic
cannot. Use it from Grafana (on your computer or the server), or from OpenSearch Dashboards. Both need
a way to reach OpenSearch, and for a computer other than the server that means opening it to the
network, which is not set up here yet - see [Open questions](#open-questions).

How heavy is each? OpenSearch is the heavy one: a Java program with its own 1 GB heap by default.
Grafana and Dashboards are small by comparison - idle on a Mac, Grafana showed about 60 MB and
Dashboards about 20 MB resident (macOS under-reports, so read that loosely; the packages are 810 MB and
595 MB on disk). Either can sit on the server alongside OpenSearch; the question is who logs in to it,
not whether it fits.

**None of this is for the Raspberry Pi bridge.**

> **Status:** the Grafana and Mac steps were followed on macOS with Homebrew (OpenSearch 3.9.0,
> Dashboards 3.9.0, Grafana 13.3.0). The Linux steps are taken from OpenSearch's and Grafana's own
> installation guides and have **not yet been run on a Linux server** - correct them where they differ.

We use **OpenSearch**, not Elasticsearch: it is Apache-licensed, installs with Homebrew and apt, and
Grafana can read it. OpenSearch Dashboards is its fork of Kibana, so Kibana guides are close but not
identical. (The reasoning is also in a comment above the `OpenSearch` class in frugal-iot-logger's
`index.js`, in case the decision is revisited.)

---

## 1. On your own computer: Grafana

On a Mac:

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

For other systems, Grafana's own download page has installers for [Windows, Linux and others](https://grafana.com/grafana/download).

Then continue at [GRAFANA.md](GRAFANA.md) to make a token and chart your readings.

To stop it: `brew services stop grafana` (Homebrew restarts it at login until you do).

---

## 2. On the server: OpenSearch

Only needed for the OpenSearch route above. Debian or Ubuntu.

`apt-get` does the installing. The `curl` line just downloads the signing key for OpenSearch's
repository, which apt needs in order to trust it:

```sh
sudo apt-get update && sudo apt-get -y install lsb-release ca-certificates curl gnupg2
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://artifacts.opensearch.org/publickeys/opensearch-release.pgp \
  | sudo gpg --dearmor -o /etc/apt/keyrings/opensearch.gpg
```

Then add OpenSearch's apt repository - the `3.x/apt` line from
[their Debian guide](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/debian/),
which is printed there for your architecture - and install, choosing an admin password now:

```sh
sudo apt-get update
sudo env OPENSEARCH_INITIAL_ADMIN_PASSWORD='<choose-a-strong-password>' apt-get install opensearch
sudo systemctl enable opensearch
sudo systemctl start opensearch
curl https://localhost:9200 -u 'admin:<that password>' --insecure
```

(That last `curl` only checks that it is answering. `--insecure` here means "do not check the
certificate", because the one it ships with is self-signed.)

This install **has the security plugin switched on**: HTTPS, a login, and that self-signed certificate.
The password is only used to set up that demo security configuration. Config is in
`/etc/opensearch/opensearch.yml` and the memory setting in `/etc/opensearch/jvm.options`.

- **Memory:** the file ships with `-Xms1g` and `-Xmx1g` (a 1 GB heap). Give both lines the same value;
  more helps with a lot of history, and the machine needs that much free *beyond* what the server,
  broker and logger use. The data is small: all 598,000 readings of the `dev` organization came to
  about 35 MB.
- **If it will not start**, look at `journalctl -u opensearch`. A common cause on Linux is the kernel
  setting `vm.max_map_count` being below 262144; `sudo sysctl -w vm.max_map_count=262144` fixes it until
  reboot, and a line in `/etc/sysctl.d/` makes it permanent.
- **Do not open port 9200 to the internet.** The demo certificate and the password are not a basis for
  that. Leave it listening on the machine itself, which is all the logger needs.

### Send readings to it

In the dashboard, open the project's back, then the **Forwarders** card, and add an **OpenSearch**
forwarder:

- OpenSearch URL: `https://localhost:9200`
- Username `admin` and the password you chose
- tick *Do not check the certificate* (it is self-signed, and the connection never leaves this machine)
- optionally, *Only these topics*, e.g. `dev/lotus/#`; leave it empty to send everything that is logged

It applies at once, with no restart, and creates what it needs in OpenSearch (an index template that
makes `value` a number) the first time it sends.

> Using the `admin` account for this is the simplest thing that works, not the best: it can do anything
> in OpenSearch. A role that can only write `frugaliot-*` indices would be better, and is not yet written.

### Loading the history you already have

A forwarder only sends readings from the moment it is switched on. To bring in everything already on
disk, from the server's directory (safe to repeat, and safe while the server is running):

```sh
npx --no frugal-iot-backfill-opensearch dev dry-run     # count what would be sent
npx --no frugal-iot-backfill-opensearch dev             # send it
npx --no frugal-iot-backfill-opensearch dev 2026-09-01  # only files from that day on
```

### Looking after it

- **Old months.** Readings go into one index per organization per month, named like
  `frugaliot-dev-2026.09`. To drop a month: `curl -X DELETE https://localhost:9200/frugaliot-dev-2026.02 -u admin:... --insecure`.
  The CSV files are untouched.
- **A gap while OpenSearch was down.** The forwarder does not retry a batch it could not send; the CSV
  files have everything, and the backfill above fills the gap.
- **Starting afresh.** Delete the indices (`frugaliot-*`) and run the backfill again.

---

## 3. On the server too: Grafana

Optional - for charts that need no setup on anyone's computer. Everyone who uses it then needs a login
to this Grafana, which is one more thing to look after. Because it is on the same machine as the
server, its data source can reach the server at `http://localhost:8080` and nothing has to be exposed.

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
Do not expose port 3000 to the internet without HTTPS in front of it. Then continue at
[GRAFANA.md](GRAFANA.md).

## 4. OpenSearch Dashboards

Dashboards is a separate package from OpenSearch, installed from
[its own guide](https://docs.opensearch.org/latest/install-and-configure/install-dashboards/debian/).
It listens on port 5601, and has to be told OpenSearch's address and the `admin` password in
`/etc/opensearch-dashboards/opensearch_dashboards.yml`. Then, in Dashboards: **Dashboards Management →
Index patterns → Create**, enter `frugaliot-*`, and choose `@timestamp` as the time field.

Do not expose 5601 to the internet either, without HTTPS in front of it. Whether to offer it to users
at all, or only Grafana, is a decision still to make - see [Open questions](#open-questions).

---

## For developers: trying the OpenSearch forwarder on a Mac

Not something users do. To work on the logger's OpenSearch forwarder you want OpenSearch on your own
machine:

```sh
brew install opensearch opensearch-dashboards
brew services start opensearch
curl http://localhost:9200          # a block of JSON with "cluster_name"
```

Homebrew's OpenSearch has **no security plugin**: it listens on `http://localhost:9200` with no login,
and only your own machine can reach it. In the Forwarders card, use `http://localhost:9200` and leave
the username and password empty.

Dashboards will not start until a folder exists that Homebrew forgot to create:

```sh
mkdir -p /opt/homebrew/var/run
brew services start opensearch-dashboards
```

(Without it the service shows `error 1` in `brew services list`, and the log
`/opt/homebrew/var/log/opensearch-dashboards.log` says it cannot open `opensearchDashboards.pid`.)
It is then at <http://localhost:5601>; create the `frugaliot-*` index pattern as in section 4.

To stop them: `brew services stop opensearch-dashboards opensearch`.

---

## Open questions

Please add what you find:

- The Linux steps above have not been run. In particular: the exact `apt` repository line, whether
  OpenSearch Dashboards is in the same repository, and the Dashboards configuration.
- **Reaching OpenSearch from another computer.** Grafana or Dashboards on your own computer cannot use
  OpenSearch on the server without opening its port, with a proper certificate and per-organization
  logins so one organization cannot read another's readings. That is not set up.
- A write-only OpenSearch role for the logger, in place of `admin`.
- Whether to offer OpenSearch Dashboards to users at all, or only Grafana.
