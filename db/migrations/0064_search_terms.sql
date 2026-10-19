-- What people search for on the site, a row a Beijing day for each term, for the admin's stats
-- (design §10.1). Not who searched. Kept 400 days.
CREATE TABLE search_terms (
  day       date    NOT NULL,
  term      text    NOT NULL,
  searches  integer NOT NULL,
  empty     integer NOT NULL,
  PRIMARY KEY (day, term)
);
