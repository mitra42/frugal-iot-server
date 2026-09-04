-- Add permissions.project to a database created before it existed.
--
-- Run only when the column is absent - scripts/init.zsh checks. Rebuilding the table rather than
-- ALTER TABLE ADD COLUMN because the UNIQUE constraint has to change too, and SQLite cannot alter a
-- constraint. Wrapped in a transaction so a failure leaves the old table in place.
--
-- Existing rows get project = '', meaning organization-wide, so every permission keeps behaving
-- exactly as it did and nothing needs re-granting.
BEGIN;
CREATE TABLE `permissions_new` (
  `id` INTEGER NOT NULL,
  `capability` TEXT NOT NULL,
  `org` TEXT NOT NULL,
  `project` TEXT NOT NULL DEFAULT '',
  UNIQUE(`id`, `capability`, `org`, `project`)
);
INSERT INTO `permissions_new` (`id`, `capability`, `org`, `project`)
  SELECT `id`, `capability`, `org`, '' FROM `permissions`;
DROP TABLE `permissions`;
ALTER TABLE `permissions_new` RENAME TO `permissions`;
COMMIT;
