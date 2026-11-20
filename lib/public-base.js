/**
 * Where this server is reached from outside - the scheme and host for any link it hands out: a chart
 * link from MCP's graph_link, the enrolment URL baked into a node's build, a device schema's base,
 * the link in a password reset email.
 *
 * Behind a reverse proxy the request itself often says only where the PROXY sent it -
 * http://127.0.0.1:8080 - which is how a chart link from production came out pointing at
 * localhost. So:
 *   1. server.yaml baseurl, when set - the answer for any server behind a proxy
 *   2. email.yaml baseurl, which said the same thing for reset emails before this existed
 *   3. otherwise the request: req.host honours X-Forwarded-Host and req.protocol X-Forwarded-Proto,
 *      as 'trust proxy' is set - right on a Pi reached directly, and behind a proxy that sends both
 */
export function publicBase(req, config = {}) {
  const configured = (config.server && config.server.baseurl) || (config.email && config.email.baseurl);
  if (configured) return String(configured).replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}
