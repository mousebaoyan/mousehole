-- 保研定位 (design §8.14) rates each school with 不清楚 too, after the grades, for those who can't
-- tell.
INSERT INTO poll_options (thread_id, row, position, label)
SELECT polls.thread_id, r.n, 5, '不清楚'
FROM polls, generate_series(0, cardinality(polls.rows) - 1) AS r(n)
WHERE polls.preset = 'positioning';
