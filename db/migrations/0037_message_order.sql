-- Where each message comes in the floor it was archived into, in the order the bot gave them:
-- NapCat's message IDs do not grow with time, and reminders quote a question's first message
-- (design §8.6). Floors archived before go by message ID, which is the order of imported history.
ALTER TABLE qq_message_links ADD COLUMN position smallint;
UPDATE qq_message_links l SET position = o.position
FROM (
  SELECT chat_type, chat_id, message_id,
    row_number() OVER (PARTITION BY post_id ORDER BY message_id) - 1 AS position
  FROM qq_message_links
) o
WHERE (l.chat_type, l.chat_id, l.message_id) = (o.chat_type, o.chat_id, o.message_id);
ALTER TABLE qq_message_links ALTER COLUMN position SET NOT NULL;
