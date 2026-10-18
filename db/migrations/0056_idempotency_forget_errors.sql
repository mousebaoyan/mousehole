-- Errors are no longer kept as a key's result, so a request put right runs again under the same
-- key; those kept before go too.
DELETE FROM idempotency_keys WHERE status >= 400;
