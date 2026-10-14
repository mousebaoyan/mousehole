-- Threads of the last seven days: the hot list and the 新 tab start from them.
CREATE INDEX threads_recent ON threads (created_at DESC)
  WHERE deleted_at IS NULL AND status = 'visible';
