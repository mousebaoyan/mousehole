-- Letters and digits now end where Han begins ("2026年" is 2026 and 年), so posts are indexed anew:
-- the server fills the emptied table on start (docs/data-model.md).
TRUNCATE post_search;
