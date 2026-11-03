/*
 * Checks shared by the routes an organization's administrator uses to hand out access (Grafana
 * tokens) and to send readings elsewhere (forwarders). Both act on the WHOLE organization, so they ask
 * for more than the ordinary ADMIN check does.
 */

// A form POST needs no CORS preflight, so a page on another site can send one using an
// administrator's logged-in session; JSON it cannot send without the browser asking this server first,
// and the server does not agree. This server also parses form bodies for every route (login needs it),
// so what these routes must do is refuse them. Not a replacement for a SameSite session cookie.
export function jsonOnly(req, res, next) {
  if (req.is('application/json')) return next();
  const message = 'Send JSON (Content-Type: application/json)';
  res.status(415).json({ error: message, message });
}

// ADMIN for the whole organization, not just for one project of it. can_ADMIN answers "anywhere in
// this organization", so an administrator of a single project passes it - and a token or a forwarder
// reaches every project's readings.
export function orgWideAdmin(req, res, next) {
  const ok = req.user && Array.isArray(req.user.permissions)
    && req.user.permissions.some((p) => p.capability === 'ADMIN' && p.org === req.params.org && !p.project);
  if (ok) return next();
  const message = 'This needs ADMIN for the whole organization, not for one project of it';
  res.status(403).json({ error: message, message });
}
