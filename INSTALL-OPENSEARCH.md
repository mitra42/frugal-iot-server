# Installing OpenSearch, Grafana and Dashboards

This is for **browsing and charting your readings**. All of it is optional - the server and logger work
without any of it, and the readings are always safe in the CSV files under `data/`, 
and the client has its own graphing. 

## What the pieces are

OpenSearch is **two programs**:

- **OpenSearch** is the database. It stores and searches the readings, and listens on port 9200.
- **OpenSearch Dashboards** is a separate web app for searching and charting what is in OpenSearch. 
  It access readings from OpenSearch at port 9200, using one login in its own
  configuration file. (It also keeps its own saved dashboards *inside* OpenSearch, in an index.)

## The ways to use it

| | Readings are kept in | You look at them with | Set up |
|---|---|---|---|
| **(a) OpenSearch on the server** | OpenSearch on the production server | OpenSearch Dashboards on **your own computer** | sections 2, 3, 4, 5 |
| **(b) OpenSearch on your own machine** | OpenSearch on a machine you run, which the server sends readings to | whatever you like - you run it all | section 6 |

Either of (a) and (b) can be used with Grafana too.

**None of this is for the Raspberry Pi bridge.**

> **Status:** the Grafana and Mac steps were followed on macOS with Homebrew (OpenSearch 3.9.0,
> Dashboards 3.9.0, Grafana 13.3.0). The Linux steps, the logins for Dashboards, and the Apache setup 
> have been run on the production server at frugaliot.naturalinnovation.org

We use **OpenSearch**, not Elasticsearch: it is Apache-licensed, installs with Homebrew and apt, and
Grafana can read it. OpenSearch Dashboards is its fork of Kibana, so Kibana guides are close but not
identical. (The reasoning is also in a comment above the `OpenSearch` class in frugal-iot-logger's
`index.js`, in case the decision is revisited.)

How heavy is each? OpenSearch is the heavy one: a Java program with its own 1 GB heap by default.
Dashboards are small by comparison (about 60 MB and 20 MB resident on a Mac, which
under-reports, so read that loosely).

## 1. (a) On the server: OpenSearch

**Debian or Ubuntu.**

**First, check there is room.** OpenSearch with its default 1 GB heap takes about 1.4 GB of RAM in
total (measured on a 2.4 GB server, where it became by far the biggest process). Run this *before*
installing:
```sh
free -h
```
The `available` column is what is left for OpenSearch; you want at least 1.5 GB. If you have less, either add
memory or give OpenSearch a smaller heap (the step before starting it, below). Run it again after
OpenSearch is started and `available` will, of course, be much lower; `top` (press `M` to sort by
memory, `q` to quit) shows what is using it.

Install the prerequisites
```sh
sudo apt-get update && sudo apt-get -y install lsb-release ca-certificates curl gnupg2
```
Fetch the signing key for OpenSearch's repository
```sh
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://artifacts.opensearch.org/publickeys/opensearch-release.pgp \
  | sudo gpg --dearmor -o /etc/apt/keyrings/opensearch.gpg
```
Add OpenSearch's apt repository
```sh
echo "deb [signed-by=/etc/apt/keyrings/opensearch.gpg] https://artifacts.opensearch.org/releases/bundle/opensearch/3.x/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/opensearch-3.x.list
```

Choose a strong password to replace `<strong password>` with below. Installing does not start it yet.
```sh
sudo apt-get update
sudo env OPENSEARCH_INITIAL_ADMIN_PASSWORD='<strong password>' apt-get install opensearch
sudo systemctl enable opensearch
```

**Set the memory before starting.** It is set in `/etc/opensearch/jvm.options`, which ships with `-Xms1g`
and `-Xmx1g` (a 1 GB heap). If `free -h` above showed less than 1.5 GB available, change both lines to
`512m`, which is enough for a little data: all 598,000 readings of the `dev` organization came to about
35 MB. More heap helps with a lot of history, but the machine needs the whole amount free *beyond* what
the server, broker, database and logger already use. You can change it later, then
`sudo systemctl restart opensearch`.

The other settings, in `/etc/opensearch/opensearch.yml`, need no change.

Now start it. This can take a couple of minutes.
```sh
sudo systemctl start opensearch
```
Check it is answering (`--insecure` means "do not check the certificate", because the one it ships with
is self-signed):
```sh
curl https://localhost:9200 -u 'admin:<strong password>' --insecure
```

This install **has the security plugin switched on**: HTTPS, a login, and that self-signed certificate.
The password is only used to set up that demo security configuration.

- **If it will not start**, look at `journalctl -u opensearch`. A common cause on Linux is the kernel
  setting `vm.max_map_count` being below 262144; `sudo sysctl -w vm.max_map_count=262144` fixes it until
  reboot, and a line in `/etc/sysctl.d/` makes it permanent.
- **Leave OpenSearch listening on the machine itself** (the default). Only Apache, below, is open to the
  internet - never port 9200 directly. Check under [Keeping it safe](#keeping-it-safe).

### Tell the Frugal IoT Server about it

Make `config.d/opensearch.yaml` in the server's directory (a commented example ships there),

```yaml
node: https://localhost:9200       # where THIS server reaches OpenSearch: on this machine
username: admin                    # what the forwarder writes readings as
password: <the password you chose>
insecure: true                     # OpenSearch's demo certificate cannot be checked; fine on this machine
admin:                             # the account that makes the per-organization logins (section 4)
  username: admin
  password: <the same>
public: https://search.example.org # the address people outside reach it at - section 3
```
 and restart the Frugal IoT server:
 
 ```sh
 sudo service frugaliot restart
 ```

The lines go at the top level of the file - the file's name already says they are about `opensearch`.

This file is never sent to a browser. `username:` and `password:` at the top must be an account OpenSearch
knows - the `admin` one you chose when installing - or every send fails with "Response Error" and the
logger's journal says so. Using `admin` for everything is the simplest thing that works, not
the best: a role that can only write `frugaliot-*` for the forwarder would be better, and is not yet
written. Leave `admin:` and `public:` out until you have done sections 3 and 4.

### Send readings to it

In the dashboard, open the project's back, then the **Forwarders** card (not the **OpenSearch** card), and add **OpenSearch on this
server**. There is no address or password to type: they come from the file above. Optionally set *Only
these topics*, e.g. `dev/lotus/#`; leave it empty to send everything that is logged.

Readings are sent in batches every few minutes, so the first ones take a few minutes to show up. It applies at once, with no restart, and creates what it needs in OpenSearch (an index template that
makes `value` a number) the first time it sends. An organization's administrator can add it for their own
organization, so only do this if you are happy for them to have their readings in OpenSearch.

### Loading the history you already have

A forwarder only sends readings from the moment it is switched on. To bring in what is already recorded,
open the **Forwarders** card, and on the OpenSearch forwarder's row press **Send earlier readings...**.
Pick the day to start from (leave it empty for everything), optionally tick *Only count them* to see how
many there are first, and press **Start**. It runs in the background and the card shows how many it has
sent so far. It is safe to repeat, and safe while the server is running.

The same thing from a terminal, in the server's directory, if you prefer:

```sh
npx --no frugal-iot-backfill-opensearch dev dry-run     # count what would be sent
npx --no frugal-iot-backfill-opensearch dev             # send it
npx --no frugal-iot-backfill-opensearch dev 2026-09-01  # only files from that day on
```

### Looking after it

Run these on the server, in a terminal. `admin:<strong password>` is the login and password you chose when
installing OpenSearch; `--insecure` is the same "don't check the certificate" as before.

- **See what is there.** One line per index, with its size:
  ```sh
  curl -s 'https://localhost:9200/_cat/indices/frugaliot-*?v' -u 'admin:<strong password>' --insecure
  ```
- **Old months.** Readings go into one index per organization per month, named like
  `frugaliot-dev-2026.09` (that name is in the first column above). To drop one:
  ```sh
  curl -X DELETE 'https://localhost:9200/frugaliot-dev-2026.02' -u 'admin:<strong password>' --insecure
  ```
  The CSV files are untouched, so nothing is lost for good.
- **A gap while OpenSearch was down.** The forwarder does not retry a batch it could not send; the CSV
  files have everything, and *Send earlier readings* (above) fills the gap.
- **Starting afresh.** Delete each index listed above, as for an old month, and send the earlier readings again.

---

---

## 3. (a) Apache: HTTPS in front of OpenSearch

Dashboards on someone's computer reach OpenSearch across the internet, it needs HTTPS. 

While opensearch ships with HTTP and some self-signed certificates, for most practical installs it will be behind an Apache proxy.

We'll add a domain name to it - e.g. `opensearch.naturalinnovation.org`

Add components needed for Apache
```sh
sudo a2enmod ssl proxy proxy_http headers
```

You need a DNS record pointing `search.example.org` (use your own name) at this server, and a
certificate for it, made the way you made the server's own, e.g. `sudo certbot certonly --apache -d search.example.org`.

Your certificate may be a wildcard one (e.g. `*.example.org`) you already have; then use its files in
the two `SSLCertificate...` lines below.

Make a new file for this site, `/etc/apache2/sites-available/opensearch.conf` (Debian and Ubuntu keep
every Apache site in that folder; it is separate from your existing site's file), with:
```apache
<VirtualHost *:443>
  ServerName search.example.org
  # your certificate, as for the server's own site (e.g. from certbot)
  SSLEngine on
  SSLCertificateFile    /etc/letsencrypt/live/search.example.org/fullchain.pem
  SSLCertificateKeyFile /etc/letsencrypt/live/search.example.org/privkey.pem

  # Apache to OpenSearch, on this machine. OpenSearch's own certificate is the self-signed demo one,
  # so do not try to check it - the connection never leaves the machine.
  SSLProxyEngine on
  SSLProxyVerify none
  SSLProxyCheckPeerCN off
  SSLProxyCheckPeerName off
  ProxyPreserveHost off
  ProxyPass        / https://127.0.0.1:9200/
  ProxyPassReverse / https://127.0.0.1:9200/

  # Nobody outside manages logins or roles. The server does that itself, on the machine, not through
  # here - and this keeps the admin account's management calls off the internet.
  <LocationMatch "^/_plugins/_security/api">
    Require all denied
  </LocationMatch>
</VirtualHost>
```
Switch the site on, then test and reload Apache:
```sh
sudo a2ensite opensearch
sudo apachectl configtest && sudo systemctl reload apache2
```
Check from your own computer:
`curl https://search.example.org` should answer 401 (it wants a login) - not a block of JSON, or HTML, and not a
timeout. 

Put the address (with the `https://`) in `public:` in `config.d/opensearch.yaml`, with the `admin:` lines
from section 1, then restart the server so it reads the file: `sudo systemctl restart frugaliot`.

Port 9200 itself stays closed to the network (firewall) - only Apache's 443 is open.

---

## 4. (a) A login for each person

Dashboards needs a login to OpenSearch, and it must not be able to read another organization's readings.
Each person who wants Dashboards opens, in the dashboard, the project's back, then the **OpenSearch** card,
and presses **Make a login**. It is theirs, named `frugaliot_<org>_<username>` (for example
`frugaliot_dev_mitra`), so the same person has a separate one in each organization. The server then,
through OpenSearch's security API:

- makes (or refreshes) a **role** `frugaliot_<org>`, shared by that organization's people, that may **read**
  the organization's readings (`frugaliot-<org>-*`) and nothing else, plus do anything to the
  organization's own saved-dashboards index (`.kibana_<org>*`) - so the people of an organization share
  their saved dashboards, and two organizations do not see each other's;
- makes the person's **user** with a new password, shown once, and connects it to the role.

*Replace the password* makes a new one; *Remove my login* deletes it, and nobody else's. An administrator
of the whole organization also sees everyone's logins on the card and can remove one - do that when
someone leaves, because **OpenSearch does not notice a change to who may read** on the dashboard: a login
stays until it is removed.

It needs **READ for the whole organization**: the role covers all of it, so someone who can read only
some projects is told to use Grafana, whose tokens follow project permissions. It works only for an
organization whose id is **lower-case letters and digits**, a username of letters, digits and `. _ -`, and
only with the `admin:` and `public:` lines of `config.d/opensearch.yaml` filled in. The card says what is
missing.

---

## 5. (a) OpenSearch Dashboards, on your own computer

Whoever wants it installs OpenSearch Dashboards **on their own computer** - not on the server. On a Mac:

```sh
mkdir -p /opt/homebrew/var/run       # Homebrew forgets this folder, and Dashboards will not start without it
brew install opensearch-dashboards
```

(Other systems: [OpenSearch's download page](https://opensearch.org/downloads.html).) Then put the lines the
card showed into the Dashboards configuration file (`/opt/homebrew/etc/opensearch-dashboards/opensearch_dashboards.yml`
on a Mac), start it (`brew services start opensearch-dashboards`) and open <http://localhost:5601>:

```yaml
opensearch.hosts: [ "https://search.example.org" ]
opensearch.username: "frugaliot_dev_mitra"
opensearch.password: "..."
opensearchDashboards.index: ".kibana_dev"
opensearch.requestHeadersAllowlist: []
opensearch.customHeaders: { authorization: "Basic <the login, encoded - the card writes this line for you>" }
```

The `opensearchDashboards.index` line is what gives the organization its own place to keep saved
dashboards; without it Dashboards uses `.kibana`, which this login cannot touch. The last two lines stop Dashboards asking your browser for a login: Dashboards uses the login above
only for its own housekeeping, so they add the same login to every request. Copy the whole block from
the card - the `Basic ...` line is the username and password encoded, which you cannot easily write by
hand. Nothing is typed when you open Dashboards. Keep Dashboards on your own computer: it listens on
`localhost` by default, and anyone who can reach its port acts as this login. 

Open opensearch - by default it will be on `http://localhost:5601`

Then, in Dashboards:
**Dashboards Management → Index patterns → Create**, enter `frugaliot-<org>-*` (e.g. `frugaliot-dev-*`; your login can read only your own organization's), and choose `@timestamp` as the
time field.

If it says the pattern **"doesn't match any indices"**, OpenSearch has no readings for your organization yet:
the forwarder (section 2, "Send readings to it") is not added, or nothing has been sent. Readings only
arrive once the forwarder is on, so send the earlier ones as in "Loading the history you already have".
You can check from your own computer with the login that is in the Dashboards file - the generated one the card
showed (not the OpenSearch `admin` password). This reads it from the file on a Mac; use your own address
and organization:
```sh
curl -s -u "$(awk -F'"' '/^opensearch.username/{u=$2} /^opensearch.password/{p=$2} END{print u":"p}' /opt/homebrew/etc/opensearch-dashboards/opensearch_dashboards.yml)" 'https://search.example.org/frugaliot-dev-*/_count'
```
`"count":0` with `"total":0` shards means none are there; a number above 0 means they are.

If it says **"OpenSearch Dashboards server is not ready yet"**, look at its log
(`/opt/homebrew/var/log/opensearch-dashboards.log` on a Mac): it names what it could not do. A
`security_exception ... no permissions for [...]` line means the organization's role on the server is
missing that permission - press **Replace the password** on the OpenSearch card once (the server rewrites
the role), then restart Dashboards. A stalled "Another OpenSearch Dashboards instance appears to be
migrating" means a first start was interrupted; as the message says, delete the index it names
(`.kibana_<org>_1`, see "Looking after it" for the command) and restart it.

### Seeing your readings as a chart

Checked step by step against OpenSearch Dashboards 3.9 in a browser. Each reading has these fields:
`value` (the number), `@timestamp`, and `topic` split into `node` (the device), `module` and `leaf`
(e.g. `temperature`). First look at **Discover** (☰ menu, top left): with `frugaliot-<org>-*` chosen you
see a bar chart of how many readings arrived, and the readings below it.

Now a chart of one kind of reading, a line per device:

1. Go to **Visualize** (<http://localhost:5601/app/visualize>) and press **Create new visualization**.
   Choose **Line**, then your `frugaliot-<org>-*` index pattern.
2. At the top right, click the calendar icon beside the time and choose **Last 24 hours**. The default
   is the last 15 minutes, which is nearly always empty.
3. In the right-hand panel, under **Metrics**, open **Y-axis**. Set **Aggregation** to **Average**
   (type "Average" and pick it). **Field** fills itself in with `value`.
4. Under **Buckets** press **Add**, choose **X-axis**, and set **Aggregation** to **Date Histogram**
   (**Field** fills itself in with `@timestamp`). Press **Update** at the bottom right.
   You now have one line, but it averages every kind of reading together (temperature, humidity,
   wifi...), so the numbers mean nothing.
5. In the search bar above the chart type `leaf:temperature` and press Enter. Now only temperatures
   are charted.
6. Under **Buckets** press **Add** again, choose **Split series**, set **Sub aggregation** to **Terms**
   and **Field** to `node`. Press **Update**. You get one line per device, with its name in the legend.
7. Press **Save** (top right), give it a title such as `Temperature by device`, and **Save**.

Put it on a dashboard:

1. Go to **Dashboards** (<http://localhost:5601/app/dashboards>) and **Create new dashboard**.
2. Press **Add** (top right), click your chart in the list, and close the list with the **X**.
3. Press **Save**, give it a title, switch on **Store time with dashboard** (otherwise it opens on the
   last 15 minutes and looks empty), and **Save**.

To chart something else, change `temperature` in step 5 to `humidity` or another `leaf`, or leave the
search empty and split by `topic` instead of `node`.

You can use the same login in **Grafana** instead, with its OpenSearch data source and the same address.

---

## 6. (b) OpenSearch on your own machine

If you already run OpenSearch somewhere (or want to), the server can send readings to it. Nothing needs
installing on the Frugal IoT server. In the dashboard, the **Forwarders** card, add **OpenSearch on
another server**, with:

- its URL - **https**, reachable from the Frugal IoT server over the internet;
- a username and password, or an API key, for an account that can write indices (`frugaliot-*`) and
  create the index template;
- optionally *Only these topics*.

What it must be: on a **public address**, with a **certificate that can be checked** (a real one, not a
self-signed demo certificate). The server refuses an address on its own machine or on a private network
(`localhost`, `192.168.x.x`, `10.x.x.x`) and cannot be told to skip the certificate check. So a computer
at home behind a router will not work unless you make it reachable (a forwarded port, a tunnel, or put
OpenSearch on a small cloud machine). The forwarder only sends **new** readings; to load history, the
operator runs the backfill from section 2 (it reads the same forwarder).

---

## Keeping it safe

Which login can see what:

| | Can read | How it is kept in |
|---|---|---|
| Grafana token | what its maker may READ, in one organization | checked by this server on every request |
| Dashboards login (one per person per organization) | the whole of one organization's readings (`frugaliot-<org>-*`) | OpenSearch's own role; stays until removed |
| the `admin` login in `config.d/opensearch.yaml` | everything, and can change security | stays on the machine, never sent anywhere |

1. **OpenSearch listens on the machine itself only.** Check, on the server:
   ```sh
   sudo ss -ltnp | grep -E ':(9200|9300)\b'
   ```
   Both should show `127.0.0.1` or `[::1]`, not `0.0.0.0` or `*`. If not, look for a `network.host` line
   in `/etc/opensearch/opensearch.yml` and remove it. Block 9200 and 9300 in your firewall as well.
2. **Only Apache's HTTPS port faces the internet**, and it refuses `/_plugins/_security/api`. Do not
   expose OpenSearch's own port, and do not run Dashboards on the server.
3. **The demo security setup is for trying things out.** It ships certificates that are the same on every
   OpenSearch install, and accounts that are not meant for production. The `admin` account is now
   reachable through Apache for anyone who guesses its password, so choose a long one, and consider
   changing OpenSearch's built-in accounts you do not use (Security → Internal users in Dashboards).
   Rate-limiting repeated failures (`fail2ban`) in front of that site is worth doing.
4. **Passwords in the database.** The Forwarders card's password for *another server* is stored in the
   clear in the server's database (`frugal-iot.db`), like every other credential in this system, and
   never sent back. The `config.d/opensearch.yaml` file holds `admin`'s password: protect it like
   `secrets.yaml`.
5. **Anything put in front of Grafana for other people needs HTTPS**, and one Grafana organization per
   Frugal IoT organization, each with its own data source and token - everyone in a Grafana organization
   shares its data sources.

---

## 7. Optional: Grafana on the server too

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
and only your own machine can reach it. Make `config.d/opensearch.yaml` in your server's directory contain
just:

```yaml
node: http://localhost:9200
```

and restart the server. The Forwarders card then offers **OpenSearch on this server**. The Dashboards
access card will say it cannot make logins, since that needs the security plugin; on your own Mac you
do not need one, because Dashboards reaches `http://localhost:9200` with no login.

Dashboards will not start until a folder exists that Homebrew forgot to create:

```sh
mkdir -p /opt/homebrew/var/run
brew services start opensearch-dashboards
```

(Without it the service shows `error 1` in `brew services list`, and the log
`/opt/homebrew/var/log/opensearch-dashboards.log` says it cannot open `opensearchDashboards.pid`.)
It is then at <http://localhost:5601>; create the `frugaliot-*` index pattern as in [section 5](#5-opensearch-dashboards-on-your-own-computer).

To stop them: `brew services stop opensearch-dashboards opensearch`.

---

---

## Open questions

Please add what you find:

- **The Linux steps have not been run for the opensource-dashboards**: the exact `apt` repository line, and the Apache site above.
- **`opensearchDashboards.index`** is meant to give each organization its own saved-objects index. Check
  that two organizations' Dashboards do not see each other's saved dashboards, and that neither can open
  the other's `.kibana_<org>`.
- **A write-only role for the forwarder**, in place of `admin`. Not written, because it cannot be tested
  on a Mac. It needs to be able to install the index template too, or `value` loses its decimals (the
  forwarder logs when it cannot).
- **Limiting a login to one project** (OpenSearch can filter by the `project` field of each reading) is not
  done: a Dashboards login sees the whole organization, so it needs READ for all of it.
- **Logins outlive a change of permissions.** Removing someone's READ on the dashboard does not remove their
  OpenSearch login; an administrator removes it on the card. Doing it automatically (the server already
  notes when a user's permissions change) is not built.
