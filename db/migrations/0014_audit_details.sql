-- Enough to tell who did something afterwards (design §13): the browser or client, and finding
-- everything from one address.
ALTER TABLE audit_logs ADD COLUMN user_agent text;
CREATE INDEX audit_logs_ip ON audit_logs (ip, id DESC);
