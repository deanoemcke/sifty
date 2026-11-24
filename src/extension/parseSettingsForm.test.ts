import { describe, expect, it } from 'vitest';
import { parseSettingsForm } from './parseSettingsForm';

const VALID_FIELDS = { targetIntervalMinutes: '60', maxSearchesPerTick: '3' };

describe('parseSettingsForm', () => {
  it('turns valid text fields into the numbers to save', () => {
    expect(parseSettingsForm(VALID_FIELDS)).toEqual({
      isValid: true,
      changes: { targetIntervalMinutes: 60, maxSearchesPerTick: 3 },
    });
  });

  it('ignores surrounding whitespace', () => {
    expect(
      parseSettingsForm({ targetIntervalMinutes: ' 60 ', maxSearchesPerTick: '\t3\n' })
    ).toMatchObject({
      isValid: true,
      changes: { targetIntervalMinutes: 60, maxSearchesPerTick: 3 },
    });
  });

  it.each([
    ['blank', ''],
    ['only whitespace', '   '],
    ['not a number', 'soon'],
    ['fractional', '1.5'],
    ['negative', '-3'],
    ['in exponent form', '1e2'],
    ['zero', '0'],
    ['above the maximum of a week', '10081'],
  ])('rejects an interval that is %s, naming the allowed range', (_description, value) => {
    expect(parseSettingsForm({ ...VALID_FIELDS, targetIntervalMinutes: value })).toEqual({
      isValid: false,
      errorsBySettingName: {
        targetIntervalMinutes: 'Enter a whole number from 1 to 10080',
      },
    });
  });

  it('rejects a per-run search limit above 50, leaving the valid interval unflagged', () => {
    expect(parseSettingsForm({ ...VALID_FIELDS, maxSearchesPerTick: '51' })).toEqual({
      isValid: false,
      errorsBySettingName: { maxSearchesPerTick: 'Enter a whole number from 1 to 50' },
    });
  });

  it('reports every invalid field at once', () => {
    const result = parseSettingsForm({ targetIntervalMinutes: 'x', maxSearchesPerTick: '0' });

    expect(result).toMatchObject({ isValid: false });
    expect(
      Object.keys((result as { errorsBySettingName: object }).errorsBySettingName).sort()
    ).toEqual(['maxSearchesPerTick', 'targetIntervalMinutes']);
  });
});
