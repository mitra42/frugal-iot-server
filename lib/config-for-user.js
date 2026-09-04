/*
 * What of the configuration a given user is allowed to see.
 *
 * Kept out of frugal-iot-server.js so it can be tested without starting a server: importing that
 * file reads config.yaml, connects to the broker and starts listening, none of which a unit test
 * wants. These two functions are pure - given a config and a user they return an object - which is
 * what makes the "no secret ever reaches a browser" test in test/unit/config-for-user.test.js
 * possible.
 */

// Sections of the configuration that are never sent to a browser, whatever permissions the user has.
// config.d itself is not served - the static mounts are publicdir, htmldir, datadir, privatedir and
// node_modules, so config.d/schema/devices.yaml is a 404 - and buildConfigFor is the only route by
// which anything under it reaches a browser. So this is the one place the decision belongs.
//
// A deny list rather than an allowlist on purpose: nearly every setting here is public (the schema,
// the broker URL, the logger URL), so an allowlist would be mostly bookkeeping and would break new
// public fields by forgetting them. The risk that comes with that choice - a future secret field
// being served because nobody remembered to deny it - is caught by the test suite instead, which
// asserts that nothing secret-looking appears anywhere in the result.
export const configSectionsNeverServed = [
  'secrets',   // config.d/secrets.yaml - session_secret, user_secret
  // config.d/email.yaml holds "pass", the SMTP (typically Gmail app) password. It was being served
  // to every logged-in user, which on a server with mail configured is a working credential to send
  // mail as that account - and registration is open, so "logged in" is not much of a bar. Nothing in
  // the client reads any of it: whether password reset is available is decided server-side by
  // mailConfigured(). Found by the "nothing secret-looking" test below, on its first run.
  'email',
];

// Fields within an organization's own config that are not sent.
//
// mqtt_password is the organization's shared broker credential - readwrite over its whole topic
// tree, the same one compiled into every node. Serving it to every user with READ was SEC-1: it
// made "may read" mean "may publish anything", and there was no way to revoke it. Browsers now get
// their own derived credential in user.mqtt_password instead (S4), so this can finally go.
//
// Still in config.d/organizations/<org>.yaml, because the nodes and the logger use it until S8
// retires it - it just never leaves the server.
export const orgFieldsNeverServed = ['mqtt_password'];

/*
 * Does this user hold this capability? Two different questions, depending on whether a project is
 * named, and they are both wanted:
 *
 *   hasPermissions(u, 'dev', 'READ')            "anywhere in dev?"  - one project is enough. This
 *                                               is what decides whether dev is shown at all.
 *   hasPermissions(u, 'dev', 'READ', 'lotus')   "on dev/lotus?"     - satisfied by a row for lotus
 *                                               or by an organization-wide row.
 *
 * A row's project is '' for organization-wide (see frugal-iot-createdb.sql for why empty string
 * rather than NULL), and an organization-wide row answers yes to both questions.
 */
export function hasPermissions(user, org, permission, project) {
  if (!user || !user.permissions) return false;
  return user.permissions.some((x) =>
    (x.capability === permission) && (x.org === org)
    && (!project || !x.project || (x.project === project)));
}

/*
 * Produce a copy of config holding only what this user may see. A subset of config that points at
 * the same objects where it can, rather than copying them - do not change the result.
 *
 * Two levels of filtering, because a permission can name a project:
 *   - an organization appears if the user may read it anywhere (any project is enough)
 *   - within it, only the projects they may actually read
 * So a user with READ on dev/lotus alone sees organization dev containing lotus, and is not even
 * told the other projects exist.
 */
export function buildConfigFor(config, user) {
  let oo = {
    organizations: {},
    user: user, // All data in user and permissions is visible to the user
  };
  Object.entries(config).forEach(([key, value]) => {
    if (configSectionsNeverServed.includes(key)) {
      // Deliberately absent from the result
    } else if (key === 'organizations') {
      Object.entries(value).forEach(([orgid, org]) => {
        if (hasPermissions(user, orgid, 'READ')) {
          oo.organizations[orgid] = orgForUser(user, orgid, org);
        }
      });
    } else {
      oo[key] = value;
    }
  });
  return oo;
}

// One organization, with the withheld fields gone and its projects narrowed to those this user may
// read. An organization-wide READ satisfies every project, so the common case keeps everything.
function orgForUser(user, orgid, org) {
  const out = {};
  for (const [k, v] of Object.entries(org)) {
    if (orgFieldsNeverServed.includes(k)) continue;
    if (k === 'projects' && v && typeof v === 'object') {
      const projects = {};
      for (const [projectid, project] of Object.entries(v)) {
        if (hasPermissions(user, orgid, 'READ', projectid)) projects[projectid] = project;
      }
      out[k] = projects;
    } else {
      out[k] = v;
    }
  }
  return out;
}
