-- Accounts are kept for good (design §6.1), so none is ever deleted and each keeps its QQ number.
ALTER TABLE users DROP COLUMN deleted_at;
ALTER TABLE users ALTER COLUMN qq SET NOT NULL;
