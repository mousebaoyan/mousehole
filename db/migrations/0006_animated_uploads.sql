-- Animated images are kept in one size only, so pages show the large file for them.

ALTER TABLE uploads ADD COLUMN animated boolean NOT NULL DEFAULT false;
