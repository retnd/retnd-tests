// What a freshness figure looks like on the page (safety-invariants.spec.ts).
//
// The product renders freshness through ui/shared's relativeAge, which says
// "N minutes ago", "N hours ago" or "N days ago", and the singular when N is
// one. A backup that finished a minute before the page loads is the common
// case on a fresh rig, so the pattern has to take both.
export const FRESHNESS_AGE = /(minutes?|hours?|days) ago/;
