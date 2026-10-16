// What coins come from and go to (design §8.17), without the database, so pages can say so too.
// The numbers are constants, to be tuned once the forum is in use.

export const CHECK_IN = 2;
// Each person reacting to someone's floors in a day.
export const PER_LIKER = 1;
// An accepted answer, once a day at most.
export const ACCEPTED = 10;
export const QUESTION_COST = 1;

// What the leaderboards add up: this week, this month, or all along.
export const PERIODS = ["week", "month", "all"] as const;
export type Period = (typeof PERIODS)[number];
