// What coins come from and go to (design §8.17), without the database, so pages can say so too.
// The numbers are constants, to be tuned once the forum is in use.

export const CHECK_IN = 2;
// Each person reacting to someone's floors in a day.
export const PER_LIKER = 1;
// An accepted answer, once a day at most.
export const ACCEPTED = 10;
export const QUESTION_COST = 1;
// A question asked on the forum and unanswered for a day is put up for a bounty this many days
// (design §8.19): a reply in that time earns BOUNTY_REPLY, and BOUNTY_ANSWER once accepted; one
// of the two a day.
export const BOUNTY_DAYS = 3;
export const BOUNTY_REPLY = 1;
export const BOUNTY_ANSWER = 5;

// What the leaderboards add up: this week, this month, or all along.
export const PERIODS = ["week", "month", "all"] as const;
export type Period = (typeof PERIODS)[number];
