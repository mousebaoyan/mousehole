-- Events are numbered as they commit, so reading on from a cursor never passes one that commits
-- later (docs/data-model.md): the ID an event is inserted with stands in until then. The lock, under
-- a key nothing else uses, is held from there until the commit is done.
CREATE FUNCTION number_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1);
  UPDATE events SET id = DEFAULT WHERE id = NEW.id;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER number_event AFTER INSERT ON events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION number_event();

ALTER TABLE events DROP COLUMN txid;
