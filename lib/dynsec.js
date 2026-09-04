/*
 * Talking to mosquitto's dynamic security plugin, over MQTT.
 *
 * The plugin is driven by publishing JSON to $CONTROL/dynamic-security/v1 and reading the reply on
 * the same topic - so the server needs no file access to the broker and no sudo, which is most of
 * why dynsec is worth having (SECURITY-REVIEW.md section 2, Tier 3).
 *
 * Callbacks rather than promises, per claude.md.
 */

import mqtt from 'mqtt';

// Commands go to one topic and replies come back on ANOTHER - the command topic with "/response"
// appended. Subscribing to the command topic (the obvious guess) gets no reply ever, while the
// commands themselves still execute, so it fails in the most confusing possible way: things happen
// and nothing answers. Confirmed from the broker's own log:
//   Received PUBLISH from ... '$CONTROL/dynamic-security/v1'
//   Sending  PUBLISH to   ... '$CONTROL/dynamic-security/v1/response'
const CONTROL = '$CONTROL/dynamic-security/v1';
const RESPONSE = '$CONTROL/dynamic-security/v1/response';

/*
 * Connect as the dynsec admin. config is the whole configuration; the credential comes from
 * config.secrets, written by frugal-iot-init and never served to a browser.
 *
 * cb(err, dynsec). A failure here must not be fatal to the caller: the dashboard is more useful
 * without live broker accounts than not at all, so callers log and carry on.
 */
// Nothing here may hang. A command that gets no reply - a broker without the plugin, an account
// whose role does not permit $CONTROL, a dropped connection - would otherwise leave the caller
// waiting for ever, which is what the first version of scripts/rebuild-dynsec.js did.
const REPLY_TIMEOUT_MS = 10000;

export function dynsecConnect(config, cb) {
  const secrets = (config && config.secrets) || {};
  const broker = config && config.mqtt && config.mqtt.broker;
  if (!broker) return cb(new Error('No mqtt.broker in the configuration'));
  if (!secrets.dynsec_admin_user || !secrets.dynsec_admin_password) {
    return cb(new Error('No dynsec_admin_user/password in config.d/secrets.yaml - run frugal-iot-init'));
  }

  const client = mqtt.connect(broker, {
    username: secrets.dynsec_admin_user,
    password: secrets.dynsec_admin_password,
    connectTimeout: 5000,
    reconnectPeriod: 0,        // a one-shot: callers reconnect rather than queueing behind a retry
  });

  let settled = false;
  const waiting = [];          // FIFO of {cb, timer}, one per command batch sent

  const answer = (err, res) => {
    const next = waiting.shift();
    if (!next) return;         // unsolicited, or a reply that arrived after we gave up
    clearTimeout(next.timer);
    next.cb(err, res);
  };

  client.on('message', (topic, payload) => {
    let parsed;
    try { parsed = JSON.parse(payload.toString()); } catch (e) { parsed = null; }
    if (!parsed || !parsed.responses) return answer(new Error('Unreadable reply from the plugin'));
    // Every command in the batch has its own response; the first error is the useful one.
    const bad = parsed.responses.find((r) => r.error);
    if (bad) return answer(new Error(`${bad.command}: ${bad.error}`), parsed.responses);
    answer(null, parsed.responses);
  });

  client.on('error', (err) => {
    if (!settled) { settled = true; client.end(true); return cb(err); }
    answer(err);               // in flight when the connection failed
  });
  client.on('close', () => { if (settled) answer(new Error('Connection to the broker closed')); });

  // A connect that never completes has to fail too, not wait.
  const connectTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      client.end(true);
      cb(new Error(`No answer from the broker at ${broker} within ${REPLY_TIMEOUT_MS}ms`));
    }
  }, REPLY_TIMEOUT_MS);

  client.on('connect', () => {
    client.subscribe(RESPONSE, { qos: 1 }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (err) { client.end(true); return cb(err); }
      cb(null, makeApi(client, waiting));
    });
  });
}

function makeApi(client, waiting) {
  // Send a batch and call back once with its combined result. Batching matters: creating a role and
  // its ACLs is several commands, and one round trip per batch keeps a rebuild quick.
  function send(commands, cb) {
    cb = cb || (() => {});
    if (!commands.length) return cb(null, []);
    let done = false;
    const once = (err, res) => { if (!done) { done = true; cb(err, res); } };
    const entry = {
      cb: once,
      timer: setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        once(new Error(`The plugin did not answer ${commands[0].command} within ${REPLY_TIMEOUT_MS}ms`));
      }, REPLY_TIMEOUT_MS),
    };
    waiting.push(entry);
    client.publish(CONTROL, JSON.stringify({ commands }), { qos: 1 }, (err) => {
      if (err) {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        clearTimeout(entry.timer);
        once(err);
      }
    });
  }

  /*
   * For commands that create or add: succeeding and "it was already like that" are the same outcome,
   * because every one of these is re-run - by the rebuild tool, at each login, and by a release that
   * adds a rule.
   *
   * Matching on /already/ rather than a list of exact strings, because the plugin has a different
   * wording for each command and getting one wrong makes a re-run FAIL rather than do nothing:
   * "Role already exists", "Group already exists", "Client already exists", "Group is already in
   * this role", "Client is already in this group"... The first version listed only the "already
   * exists" ones, so the second apply aborted on addGroupRole before it reached the users, and a
   * permission granted in the database never arrived at the broker.
   *
   * Safe to be broad here because this path is only ever given create/add commands - removals go
   * through raw(), where an error is an error.
   */
  function sendIgnoringExists(commands, cb) {
    send(commands, (err, res) => {
      if (err && /already/i.test(err.message)) return cb(null, res);
      cb(err, res);
    });
  }

  return {
    raw: send,
    idempotent: sendIgnoringExists,
    end: (cb) => client.end(false, {}, cb),

    listClients: (cb) => send([{ command: 'listClients', count: -1 }],
      (e, r) => cb(e, e ? null : ((r[0].data && r[0].data.clients) || []))),
    getClient: (username, cb) => send([{ command: 'getClient', username }],
      (e, r) => cb(e, e ? null : (r[0].data && r[0].data.client))),
    listGroups: (cb) => send([{ command: 'listGroups', count: -1 }],
      (e, r) => cb(e, e ? null : ((r[0].data && r[0].data.groups) || []))),
    getGroup: (groupname, cb) => send([{ command: 'getGroup', groupname }],
      (e, r) => cb(e, e ? null : (r[0].data && r[0].data.group))),
    listRoles: (cb) => send([{ command: 'listRoles', count: -1 }],
      (e, r) => cb(e, e ? null : ((r[0].data && r[0].data.roles) || []))),
    getRole: (rolename, cb) => send([{ command: 'getRole', rolename }],
      (e, r) => cb(e, e ? null : (r[0].data && r[0].data.role))),
    getAnonymousGroup: (cb) => send([{ command: 'getAnonymousGroup' }],
      (e, r) => cb(e, e ? null : (r[0].data && r[0].data.group && r[0].data.group.groupname))),
  };
}

export { CONTROL, RESPONSE };
