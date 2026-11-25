// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildServicePlist } from './servicePlist';

function parsePlist(xml: string): Record<string, unknown> {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  expect(document.querySelector('parsererror')).toBeNull();

  function readValue(element: Element): unknown {
    switch (element.tagName) {
      case 'string':
        return element.textContent ?? '';
      case 'true':
        return true;
      case 'false':
        return false;
      case 'integer':
        return Number(element.textContent);
      case 'array':
        return [...element.children].map(readValue);
      case 'dict':
        return readDictionary(element);
      default:
        throw new Error(`Unexpected plist element <${element.tagName}>`);
    }
  }

  function readDictionary(dictionary: Element): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const children = [...dictionary.children];
    for (let index = 0; index < children.length; index += 2) {
      expect(children[index].tagName).toBe('key');
      result[children[index].textContent ?? ''] = readValue(children[index + 1]);
    }
    return result;
  }

  const topLevel = document.documentElement.querySelector(':scope > dict');
  if (!topLevel) throw new Error('plist has no top-level dict');
  return readDictionary(topLevel);
}

const BASE_OPTIONS = {
  label: 'ai.openclaw.sifty-webapp',
  programArguments: ['/bin/bash', '/Users/someone/sifty/scripts/sifty-webapp-service.sh'],
  workingDirectory: '/Users/someone/sifty',
  logFilePath: '/tmp/sifty-webapp.log',
};

describe('buildServicePlist', () => {
  it('describes the job: label, command and working directory', () => {
    expect(parsePlist(buildServicePlist(BASE_OPTIONS))).toMatchObject({
      Label: 'ai.openclaw.sifty-webapp',
      ProgramArguments: ['/bin/bash', '/Users/someone/sifty/scripts/sifty-webapp-service.sh'],
      WorkingDirectory: '/Users/someone/sifty',
    });
  });

  it('starts when loaded and restarts after a crash', () => {
    expect(parsePlist(buildServicePlist(BASE_OPTIONS))).toMatchObject({
      RunAtLoad: true,
      KeepAlive: true,
    });
  });

  it('sends output and errors to the one log file the tab reads', () => {
    expect(parsePlist(buildServicePlist(BASE_OPTIONS))).toMatchObject({
      StandardOutPath: '/tmp/sifty-webapp.log',
      StandardErrorPath: '/tmp/sifty-webapp.log',
    });
  });

  it('gives the job a PATH that finds Homebrew tools', () => {
    expect(parsePlist(buildServicePlist(BASE_OPTIONS))).toMatchObject({
      EnvironmentVariables: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
    });
  });

  it('keeps awkward characters in paths and arguments intact', () => {
    const awkward = 'a & b <c> "d" \'e\'';
    const parsed = parsePlist(
      buildServicePlist({ ...BASE_OPTIONS, programArguments: ['/bin/echo', awkward] })
    );

    expect(parsed.ProgramArguments).toEqual(['/bin/echo', awkward]);
  });

  it('refuses a plist with no command to run', () => {
    expect(() => buildServicePlist({ ...BASE_OPTIONS, programArguments: [] })).toThrow(
      /programArguments/
    );
  });

  it('refuses a relative working directory or log path, which launchd would misplace', () => {
    expect(() => buildServicePlist({ ...BASE_OPTIONS, workingDirectory: 'sifty' })).toThrow(
      /absolute/
    );
    expect(() => buildServicePlist({ ...BASE_OPTIONS, logFilePath: 'sifty.log' })).toThrow(
      /absolute/
    );
  });
});
