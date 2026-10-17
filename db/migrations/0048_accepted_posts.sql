-- Someone's accepted answers, counted on their page (design §9); few among their floors.
CREATE INDEX posts_accepted ON posts (author_id) WHERE accepted_at IS NOT NULL AND deleted_at IS NULL;
