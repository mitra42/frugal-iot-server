/*
 * Deleting retained messages, on the server's behalf rather than the browser's.
 *
 * A retained topic is removed by publishing an empty payload to it, and there is no other way: the
 * broker keeps the last value of every topic for ever, so a misspelled field or a node tested with
 * the wrong id goes on appearing on every dashboard after the node is fixed (see
 * scripts/clearretained.js, which does the same thing from the command line).
 *
 * This used to be done by the browser, using the organization's shared broker credential. S4 gave
 * each user their own credential instead, which may publish to "set/" topics and nothing else - so
 * the browser's delete stopped working, and worse, stopped working SILENTLY: an MQTT 3.1.1 broker
 * acknowledges a QoS 1 publish it is about to discard, so the client saw success and the topics
 * stayed. That is the regression this file exists to fix.
 *
 * The obvious repair - let a browser publish anywhere in its organization - would hand back exactly
 * the capability S4 removed, because the broker cannot tell "forget this reading" from "here is a
 * reading I invented". So the publishing is done here, by the server, with an account only the
 * server holds (names.orgAdminClient), after checking that every topic named is inside the
 * organization the user has ADMIN of.
 */

import mqtt from 'mqtt';
import { deriveOrgAdminPassword, names } from './dynsec-plan.js';

const NAME = /^[a-z0-9]{1,32}$/;
// One topic per node module field, and a busy organization has a few thousand. Well above anything
// legitimate, and low enough that a mistake cannot tie the broker up for minutes.
const MAX_TOPICS = 5000;

/*
 * Which credential to publish as.
 *
 * The derived per-organization admin account when there is a user_secret and the broker has the
 * plugin; otherwise the organization's own shared account, which still exists until S8 retires it.
 * The fallback is what makes this work on a server whose broker has no dynamic security - the same
 * arrangement the logger uses.
 */
export function adminCredentialFor(config, org) {
  const userSecret = config && config.secrets && config.secrets.user_secret;
  if (userSecret) {
    return { username: names.orgAdminClient(org), password: deriveOrgAdminPassword(userSecret, org) };
  }
  const o = (config && config.organizations && config.organizations[org]) || {};
  if (o.mqtt_password) return { username: org, password: o.mqtt_password };
  return null;
}

/*
 * Publish an empty retained message to each of `topics`.
 *
 * cb(err, {deleted}) - err.status is an HTTP status for the route to use, because every way this
 * can be refused is a different one.
 */
export function deleteRetained(config, org, topics, cb) {
  if (!NAME.test(String(org || ''))) return refuse(cb, 400, 'Not an organization name');
  if (!Array.isArray(topics) || !topics.length) return refuse(cb, 400, 'No topics given');
  if (topics.length > MAX_TOPICS) return refuse(cb, 400, `More than ${MAX_TOPICS} topics at once`);

  const prefix = `${org}/`;
  for (const t of topics) {
    if (typeof t !== 'string' || !t.length) return refuse(cb, 400, 'A topic was not a string');
    // Inside this organization, and one exact topic - a wildcard would let "delete these" mean
    // "delete everything", and unlike the command-line tool there is nobody here to look first.
    if (!t.startsWith(prefix)) return refuse(cb, 403, `${t} is not in ${org}`);
    if (t.includes('+') || t.includes('#')) return refuse(cb, 400, `${t} contains a wildcard`);
  }

  const broker = config && config.mqtt && config.mqtt.broker;
  if (!broker) return refuse(cb, 500, 'No mqtt.broker in the configuration');
  const cred = adminCredentialFor(config, org);
  if (!cred) return refuse(cb, 500, `No broker credential for ${org}`);

  const client = mqtt.connect(broker, {
    username: cred.username, password: cred.password,
    connectTimeout: 5000,
    reconnectPeriod: 0,      // one-shot: a retry would silently double every publish
  });

  let settled = false;
  const finish = (err, res) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.end(!!err, () => cb(err, res));
  };
  // Long enough for a few thousand publishes on a Pi, short enough that a wedged broker answers.
  const timer = setTimeout(() => finish(err500('The broker did not answer')), 30000);

  client.on('error', (err) => finish(refusal(502, `Could not reach the broker: ${err.message}`)));
  client.on('connect', () => {
    let left = topics.length;
    let failed = 0;
    for (const t of topics) {
      // An empty payload is how MQTT spells "forget this topic". QoS 1 so the broker acknowledges
      // it - though see the file header: the acknowledgement says "received", not "allowed".
      client.publish(t, '', { retain: true, qos: 1 }, (err) => {
        if (err) failed++;
        if (--left === 0) finish(null, { deleted: topics.length - failed, failed });
      });
    }
  });
}

function refusal(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function err500(message) { return refusal(500, message); }
function refuse(cb, status, message) { return cb(refusal(status, message)); }
