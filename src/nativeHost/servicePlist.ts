import path from 'node:path';

export type ServicePlistOptions = {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  logFilePath: string;
};

// launchd's default PATH for user agents is only /usr/bin:/bin:/usr/sbin:/sbin.
const SERVICE_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stringElement(text: string): string {
  return `<string>${escapeXml(text)}</string>`;
}

export function buildServicePlist(options: ServicePlistOptions): string {
  if (options.programArguments.length === 0) {
    throw new Error('programArguments must contain at least the command to run');
  }
  for (const [name, value] of [
    ['workingDirectory', options.workingDirectory],
    ['logFilePath', options.logFilePath],
  ]) {
    if (!path.isAbsolute(value))
      throw new Error(`${name} must be an absolute path, got "${value}"`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${stringElement(options.label)}
  <key>ProgramArguments</key>
  <array>
    ${options.programArguments.map(stringElement).join('\n    ')}
  </array>
  <key>WorkingDirectory</key>
  ${stringElement(options.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${stringElement(SERVICE_PATH)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${stringElement(options.logFilePath)}
  <key>StandardErrorPath</key>
  ${stringElement(options.logFilePath)}
</dict>
</plist>
`;
}
