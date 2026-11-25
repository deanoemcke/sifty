const MINUTES_PER_WEEK = 7 * 24 * 60;

// Matches launchd's StartInterval (1800s) in the external ai.openclaw.sifty-scheduler.plist.
// The scheduler cannot run more often than this, so a shorter target interval could never be met.
export const SCHEDULER_TICK_INTERVAL_MINUTES = 30;

export const SCHEDULER_SETTING_DEFINITIONS = {
  targetIntervalMinutes: {
    defaultValue: 240,
    minimum: SCHEDULER_TICK_INTERVAL_MINUTES,
    maximum: MINUTES_PER_WEEK,
  },
  maxSearchesPerTick: { defaultValue: 5, minimum: 1, maximum: 50 },
} as const;

export type SchedulerSettings = {
  -readonly [Key in keyof typeof SCHEDULER_SETTING_DEFINITIONS]: number;
};
