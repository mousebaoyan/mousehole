-- Each link is a message some floor came from, and a floor may come from several. The bot no
-- longer posts receipts in the groups, so their links go (plugin design §8).
DELETE FROM qq_message_links WHERE kind = 'notice';
ALTER TABLE qq_message_links DROP COLUMN kind;
ALTER TABLE qq_message_links ALTER COLUMN post_id SET NOT NULL;
DROP INDEX qq_message_links_post;
CREATE INDEX qq_message_links_post ON qq_message_links (post_id);
