// The app's version, shown in the room list. Keep it equal to package.json (a test checks).
export const VERSION = '0.4.0';

/** What this app can do with others, as a whole number that only goes up; announced in presence,
 *  so that an app can say "their app is older" instead of failing without a word. A peer that
 *  announces nothing is level 1. Raise it with every change an older app would not understand,
 *  and say here what it was:
 *    1  everything up to 0.4.0
 *    2  the owner's answer to a join request carries the member list */
export const PROTOCOL = 2;
