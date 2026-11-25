import {
  SCHEDULER_SETTING_DEFINITIONS,
  type SchedulerSettings,
} from '../server/schedulerSettingDefinitions';

export type SettingsFormFields = Record<keyof SchedulerSettings, string>;

export type SettingsFormResult =
  | { isValid: true; changes: SchedulerSettings }
  | {
      isValid: false;
      errorsBySettingName: Partial<Record<keyof SchedulerSettings, string>>;
    };

const WHOLE_NUMBER_PATTERN = /^\d+$/;

// Checks the form before it is sent so a typo gets an inline message; the host
// validates again with the same ranges, since it must not trust the extension.
export function parseSettingsForm(fields: SettingsFormFields): SettingsFormResult {
  const changes: Partial<SchedulerSettings> = {};
  const errorsBySettingName: Partial<Record<keyof SchedulerSettings, string>> = {};

  for (const settingName of Object.keys(SCHEDULER_SETTING_DEFINITIONS) as Array<
    keyof SchedulerSettings
  >) {
    const { minimum, maximum } = SCHEDULER_SETTING_DEFINITIONS[settingName];
    const text = fields[settingName].trim();
    const value = WHOLE_NUMBER_PATTERN.test(text) ? Number(text) : Number.NaN;

    if (Number.isInteger(value) && value >= minimum && value <= maximum) {
      changes[settingName] = value;
    } else {
      errorsBySettingName[settingName] = `Enter a whole number from ${minimum} to ${maximum}`;
    }
  }

  if (Object.keys(errorsBySettingName).length > 0) return { isValid: false, errorsBySettingName };
  return { isValid: true, changes: changes as SchedulerSettings };
}
