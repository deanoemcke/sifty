import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from './controlService';
import { installServiceAsync } from './installService';
import type { ServicePlistOptions } from './servicePlist';

const SERVICE_OPTIONS: ServicePlistOptions = {
  label: 'ai.openclaw.sifty-webapp',
  programArguments: ['/bin/true'],
  workingDirectory: '/tmp',
  logFilePath: '/tmp/sifty-webapp.log',
};

describe('installServiceAsync', () => {
  let plistDirectory: string;

  beforeEach(() => {
    plistDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-service-'));
  });

  afterEach(() => {
    fs.rmSync(plistDirectory, { recursive: true, force: true });
  });

  function install(runLaunchctlAsync: (args: string[]) => Promise<CommandResult>) {
    return installServiceAsync({
      options: SERVICE_OPTIONS,
      plistDirectory,
      userId: 501,
      runLaunchctlAsync,
    });
  }

  it('disables a first-installed service so it stays off at login', async () => {
    const runLaunchctlAsync = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });

    await install(runLaunchctlAsync);

    expect(runLaunchctlAsync).toHaveBeenCalledWith(['disable', 'gui/501/ai.openclaw.sifty-webapp']);
    expect(fs.existsSync(path.join(plistDirectory, 'ai.openclaw.sifty-webapp.plist'))).toBe(true);
  });

  it('leaves the on/off state alone when the plist is already installed', async () => {
    await install(vi.fn().mockResolvedValue({ exitCode: 0, output: '' }));
    const runLaunchctlAsync = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });

    await install(runLaunchctlAsync);

    expect(runLaunchctlAsync).not.toHaveBeenCalled();
  });

  it('still disables on a re-run after a first run whose disable failed', async () => {
    await expect(
      install(vi.fn().mockResolvedValue({ exitCode: 1, output: 'boom' }))
    ).rejects.toThrow(/launchctl disable/);
    const runLaunchctlAsync = vi.fn().mockResolvedValue({ exitCode: 0, output: '' });

    await install(runLaunchctlAsync);

    expect(runLaunchctlAsync).toHaveBeenCalledWith(['disable', 'gui/501/ai.openclaw.sifty-webapp']);
  });
});
