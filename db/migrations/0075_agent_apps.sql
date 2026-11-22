-- Agents register themselves when they first connect (design §6.7): no secret, as they are programs
-- on members' computers.
ALTER TABLE oauth_clients ALTER COLUMN secret_hash DROP NOT NULL;
