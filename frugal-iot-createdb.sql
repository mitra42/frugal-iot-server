-- Schema for the Frugal IoT server's user database (frugal-iot.db)
--
-- Run by the server at every startup (execSqlStart in frugal-iot-server.js), so any tables added
-- here since a database was first created get created on the next restart.
--
-- Can also be run by hand, e.g. before scripts/addorganization.zsh on a new installation:
--   sqlite3 frugal-iot.db < frugal-iot-createdb.sql
--
-- Everything here must be CREATE ... IF NOT EXISTS - it runs against existing databases.

-- TODO check on size of fields hashed_password and salt
-- TO-ADD-REGISTRATION-FIELD
CREATE TABLE IF NOT EXISTS `users` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `username` TEXT UNIQUE,
  `hashed_password` BLOB,
  `salt` BLOB '',
  `organization` varchar(20) NOT NULL DEFAULT '',
  `name` TEXT,
  `email` TEXT,
  `phone` TEXT
);
-- `project` scopes a permission to one project of an organization. Empty string means the whole
-- organization, which is how every row created before this column existed behaves.
--
-- NOT NULL DEFAULT '' rather than nullable, and that matters: SQLite treats NULLs as DISTINCT in a
-- UNIQUE constraint, so with a nullable column `(2,'READ','dev',NULL)` could be inserted twice and
-- the constraint that used to prevent duplicate organization-wide rows would silently stop working.
-- An empty string compares equal to itself, so uniqueness holds. It also keeps the queries simple:
-- `project = ?` everywhere, never `IS NULL`.
CREATE TABLE IF NOT EXISTS `permissions` (
  `id` INTEGER NOT NULL,
  `capability` TEXT NOT NULL,
  `org` TEXT NOT NULL,
  `project` TEXT NOT NULL DEFAULT '',
  UNIQUE(`id`, `capability`, `org`, `project`)
);
CREATE TABLE IF NOT EXISTS `projects` (
  `org` TEXT NOT NULL,
  `id` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  UNIQUE(`org`, `id`)
);
CREATE TABLE IF NOT EXISTS `api_platforms` (
 `id` INTEGER PRIMARY KEY AUTOINCREMENT,
 `name` TEXT UNIQUE NOT NULL, -- name of platform e.g. 'Lite Farm'
 `userid` INTEGER, -- Userid of Farm platform on Frugal-IoT
 `base_url` TEXT, -- For pushing to platform (in farm-platform-push.js)
 `auth_token` TEXT, -- This is auth_token for Frugal-IoT to authenticate to Farm platform when pushing
 `cookie_name` TEXT, -- Name of auth token for Frugal-IoT -> Farm Platform
 FOREIGN KEY(`userid`) REFERENCES `users(id)`
);
-- Note its possible for a farm on a platform to refer to more than one project on Frugal IoT
-- in which case there will be more than one record here with same platform_id+farm_id
CREATE TABLE IF NOT EXISTS `api_farms` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `platform_id` INTEGER, -- index into api_platforms
  `farm_id` TEXT NOT NULL, -- reference on the other platform
  `org` TEXT NOT NULL, -- if of org in Frugal IoT
  `project` TEXT NOT NULL, -- id of project in Frugal IoT
  FOREIGN KEY(`platform_id`) REFERENCES `api_platforms(id)`
);

-- ==== Tables for the Farm IoT Interoperability Standard (see API.md) ====
-- These were previously created by initializeSchema() in lib/database.js, which now runs this file.
-- TODO-API farm_platforms overlaps with api_platforms above, and users_farm_platform needs reviewing
-- TODO-API-AUTH may need to edit farm_platforms once authentication is figured out
CREATE TABLE IF NOT EXISTS farm_platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  base_url TEXT NOT NULL, -- For pushing to platform (in farm-platform-push.js)
  auth_token TEXT NOT NULL, -- This is auth_token for Frugal-IoT to authenticate to Farm platform when pushing
  cookie_name TEXT NOT NULL, -- Name of auth token for Frugal-IoT -> Farm Platform
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Users registered with Farm Platforms
CREATE TABLE IF NOT EXISTS users_farm_platform (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_platform_user_id TEXT NOT NULL,
  farm_platform_id TEXT NOT NULL,
  device_platform_user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(farm_platform_user_id, farm_platform_id),
  FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
);
-- TODO-API registerDeviceToUser() in lib/database.js reads and writes a device_farm_mappings table
-- that nothing creates - either add it here or drop that function.
-- Data push queue
CREATE TABLE IF NOT EXISTS data_push_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_platform_id TEXT NOT NULL,
  senml_packet TEXT NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
);
-- Notification queue
CREATE TABLE IF NOT EXISTS notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_platform_id TEXT NOT NULL,
  notification_packet TEXT NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(farm_platform_id) REFERENCES farm_platforms(name)
);

-- Two users every server needs, with the ids the rest of the code assumes.
-- OR IGNORE so re-running this leaves existing rows - in particular the real row 1 - untouched.
--
-- id 0 "everyone": not an account anyone logs in as. Permission rows with id 0 apply to every
-- logged-in user (see "or id = 0" in the server's LocalStrategy), and this row supplies the name
-- shown for them by sqlPeopleList in the permission-management UI.
--
-- id 1: this server's superuser, which addorganization.zsh grants ADMIN on every organization
-- it creates. Seeded with no password, so it cannot be logged into until one is set:
--   scripts/setpassword.zsh superuser <password>
-- Seeding it also reserves id 1, so the first real account created gets id 2 rather than
-- silently becoming the superuser.
INSERT OR IGNORE INTO `users` (`id`, `username`, `name`, `organization`) VALUES (0, 'everyone', 'Everyone', '');
INSERT OR IGNORE INTO `users` (`id`, `username`, `name`, `organization`) VALUES (1, 'superuser', 'Superuser', '');
