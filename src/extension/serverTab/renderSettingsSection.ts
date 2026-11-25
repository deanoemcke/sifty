import {
  SCHEDULER_SETTING_DEFINITIONS,
  type SchedulerSettings,
} from '../../server/schedulerSettingDefinitions';
import { parseSettingsForm, type SettingsFormFields } from '../parseSettingsForm';
import { createElement } from './dom';

type SettingName = keyof SchedulerSettings;

const SETTING_LABELS: Record<SettingName, { label: string; help: string }> = {
  targetIntervalMinutes: {
    label: 'Target interval (minutes)',
    help: 'No alert-enabled search should wait longer than this between runs.',
  },
  maxSearchesPerTick: {
    label: 'Searches per run',
    help: 'The most due searches one scheduler run will process.',
  },
};

export type SaveSettingsResult =
  | { kind: 'saved'; settings: SchedulerSettings }
  | { kind: 'failed'; message: string };

export type SaveSettings = (changes: SchedulerSettings) => Promise<SaveSettingsResult>;

function describeRange(settingName: SettingName): string {
  const { minimum, maximum } = SCHEDULER_SETTING_DEFINITIONS[settingName];
  return `${minimum} to ${maximum}`;
}

// Rendered once from the host's settings. Afterwards only the messages change,
// so refreshes and failed saves never overwrite what has been typed.
export function renderSettingsSection(
  container: HTMLElement,
  settings: SchedulerSettings,
  saveSettings: SaveSettings
): void {
  const settingNames = Object.keys(SETTING_LABELS) as SettingName[];
  const inputsBySettingName = new Map<SettingName, HTMLInputElement>();
  const errorsBySettingName = new Map<SettingName, HTMLElement>();
  const messageElement = createElement('p', { className: 'settings-message' });

  const fieldElements = settingNames.map((settingName) => {
    const input = createElement('input');
    input.name = settingName;
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = String(settings[settingName]);
    inputsBySettingName.set(settingName, input);

    const errorElement = createElement('span', { className: 'field-error tone-problem' });
    errorsBySettingName.set(settingName, errorElement);

    return createElement('label', { className: 'field' }, [
      createElement('span', { text: SETTING_LABELS[settingName].label, className: 'field-label' }),
      input,
      createElement('span', {
        text: `${SETTING_LABELS[settingName].help} (${describeRange(settingName)})`,
        className: 'field-help',
      }),
      errorElement,
    ]);
  });

  function readFields(): SettingsFormFields {
    return Object.fromEntries(
      settingNames.map((settingName) => [
        settingName,
        inputsBySettingName.get(settingName)?.value ?? '',
      ])
    ) as SettingsFormFields;
  }

  async function handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    messageElement.textContent = '';
    messageElement.className = 'settings-message';
    for (const errorElement of errorsBySettingName.values()) errorElement.textContent = '';

    const parsed = parseSettingsForm(readFields());
    if (!parsed.isValid) {
      for (const [settingName, message] of Object.entries(parsed.errorsBySettingName)) {
        const errorElement = errorsBySettingName.get(settingName as SettingName);
        if (errorElement) errorElement.textContent = message;
      }
      return;
    }

    const result = await saveSettings(parsed.changes);
    if (result.kind === 'saved') {
      for (const settingName of settingNames) {
        const input = inputsBySettingName.get(settingName);
        if (input) input.value = String(result.settings[settingName]);
      }
      messageElement.textContent = 'Saved. Applies from the next scheduler run.';
      messageElement.className = 'settings-message tone-ok';
    } else {
      messageElement.textContent = `Could not save: ${result.message}`;
      messageElement.className = 'settings-message tone-problem';
    }
  }

  const form = createElement('form', {}, [
    ...fieldElements,
    createElement('button', { text: 'Save settings' }),
    messageElement,
  ]);
  form.addEventListener('submit', (event) => void handleSubmit(event));

  container.replaceChildren(createElement('h2', { text: 'Scheduler settings' }), form);
}
