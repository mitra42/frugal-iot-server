/**
 * Where nodes are: for the map page (frugal-iot-client map.html) and the MCP tools.
 *
 * Two kinds of location, chosen exactly as the dashboard's map chooses them (the client's
 * MqttTopicNode.location, MAPPING_PLAN.md M-3):
 *
 *   gps   - gps/latitude and gps/longitude, from a node with a GPS that has a fix (satellites > 0).
 *           These are ordinary numeric readings and are logged, so their history is on disk.
 *   set   - frugal_iot/location, "lat,lon", set on the dashboard. It is not logged (log: false in
 *           topics.yaml), so only today's value is known - the logger keeps it as a current value.
 *
 * A GPS with a fix wins, because a device that moves should be shown where it is.
 *
 * A node without a fix publishes NaN for latitude and longitude (the firmware's OUTfloat::setInvalid),
 * which data-query.js's readRows drops as not a number - so a bucket of GPS readings never has 0,0 or
 * a stale position pulled into it, and nothing needs filtering here.
 *
 * The history of a moving node is its GPS readings bucketed like any others: per bucket, min and max
 * of latitude and longitude are its bounding box, and the mean is where to put its pin.
 */

import { stat } from 'fs/promises';
import { join } from 'path';
import { APIError } from './api-errors.js';
import { queryData, LIMITS } from './data-query.js';

const LEVEL = /^[A-Za-z0-9_.-]+$/;

// { lat, lon } if both are numbers inside the globe, otherwise null
export function validLocation(lat, lon) {
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// "lat,lon" as frugal_iot/location carries it, or null
export function parseLocation(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split(',');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) return null;
  return validLocation(parts[0], parts[1]);
}

// A node's current location, { lat, lon, source }, from the logger's getNodeState; or null
export function nodeLocation(state = {}) {
  const value = (key) => state[key] && state[key].value;
  if (Number(value('gps/satellites')) > 0) {
    const fix = validLocation(value('gps/latitude'), value('gps/longitude'));
    if (fix) return { ...fix, source: 'gps' };
  }
  const set = parseLocation(value('frugal_iot/location'));
  return set && { ...set, source: 'set' };
}

// node= may be repeated or comma-separated, each org/project/node with no "+": the map page asks
// for the nodes /api/data has just given it readings for, so it always knows them by name
export function parseNodes(node) {
  const raw = [...new Set([].concat(node === undefined ? [] : node)
    .flatMap((n) => String(n).split(','))
    .map((n) => n.trim().replace(/\/+$/, ''))
    .filter(Boolean))];
  if (!raw.length) throw new APIError('invalid_request', 'Missing required parameter: node');
  if (raw.length > LIMITS.MAX_TOPICS) {
    throw new APIError('invalid_request', `At most ${LIMITS.MAX_TOPICS} nodes in one request`);
  }
  return raw.map((n) => {
    const levels = n.split('/');
    if (levels.length !== 3 || !levels.every((l) => LEVEL.test(l) && l !== '.' && l !== '..')) {
      throw new APIError('invalid_request', `Bad node ${JSON.stringify(n)}: must be org/project/node`);
    }
    return levels;
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/*
 * Where each node is now, and - given a bucket - where its GPS put it in each bucket.
 *
 * Returns { nodes: [{ node, location: { lat, lon, source } | null, track?: [{ t, count, lat, lon,
 * south, north, west, east }] }] }, t being the bucket's start in ms. A node may not be read is
 * refused, as /api/data refuses it. track is there only for a node with GPS readings in the period.
 */
export async function queryLocations({ dataDir, mayRead, getNodeState, node, from, to, bucket, tz }) {
  const nodes = parseNodes(node);
  for (const [org, project] of nodes) {
    if (!mayRead(org, project)) throw new APIError('not_allowed', `Not allowed to read ${org}/${project}`);
  }
  const out = nodes.map(([org, project, id]) => ({
    node: `${org}/${project}/${id}`,
    location: nodeLocation(getNodeState(org, project, id)),
  }));
  if (!bucket) return { nodes: out };

  // Only nodes that have ever recorded a GPS reading: a named topic that is not there is an error to
  // queryData, and most nodes have no GPS at all
  const gps = [];
  for (const [org, project, id] of nodes) {
    if (await exists(join(dataDir, org, project, id, 'gps', 'latitude'))
      && await exists(join(dataDir, org, project, id, 'gps', 'longitude'))) gps.push(`${org}/${project}/${id}`);
  }
  if (!gps.length) return { nodes: out };
  const r = await queryData({
    dataDir, mayRead, from, to, bucket, tz, agg: 'mean,min,max,count',
    device: gps.flatMap((n) => [`${n}/gps/latitude`, `${n}/gps/longitude`]),
  });
  const series = new Map(r.series.map((s) => [`${s.org}/${s.project}/${s.node}/${s.field}`, s.buckets]));
  for (const entry of out) {
    const lat = series.get(`${entry.node}/latitude`);
    const lon = new Map((series.get(`${entry.node}/longitude`) || []).map((b) => [b.t, b]));
    if (!lat) continue;
    // A bucket needs both: they are published together, so one without the other is a reading cut
    // in half at a bucket's edge, not a position
    const track = lat.filter((a) => lon.has(a.t)).map((a) => {
      const o = lon.get(a.t);
      return { t: a.t, count: Math.min(a.count, o.count), lat: a.mean, lon: o.mean,
        south: a.min, north: a.max, west: o.min, east: o.max };
    });
    if (track.length) entry.track = track;
  }
  return { nodes: out, stats: r.stats };
}
