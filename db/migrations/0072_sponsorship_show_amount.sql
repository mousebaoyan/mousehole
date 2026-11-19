-- Whether the thanks wall shows the amount or only the tier (design §8.21). Those registered before
-- this were told only the tier shows, so they stay hidden; every new row says which.
ALTER TABLE sponsorships ADD COLUMN show_amount boolean NOT NULL DEFAULT false;
ALTER TABLE sponsorships ALTER COLUMN show_amount DROP DEFAULT;
