// The log files the extension may read, by name. The scheduler's wrapper script
// (run-and-notify.sh) and launchd write the first two; the native host's own
// wrapper writes native-host.
export const NATIVE_HOST_LOG_FILE_PATH = '/tmp/sifty-native-host.log';

// Written by the launchd services this code installs (see serviceDefinitions.ts).
export const WEBAPP_LOG_FILE_PATH = '/tmp/sifty-webapp.log';
export const NGROK_LOG_FILE_PATH = '/tmp/sifty-ngrok.log';

export const LOG_FILE_PATHS_BY_LOG_NAME: Record<string, string> = {
  scheduler: '/tmp/sifty-scheduler.log',
  'scheduler-launchd': '/tmp/sifty-scheduler-launchd.log',
  webapp: WEBAPP_LOG_FILE_PATH,
  ngrok: NGROK_LOG_FILE_PATH,
  'native-host': NATIVE_HOST_LOG_FILE_PATH,
};
