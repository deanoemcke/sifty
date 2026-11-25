import type { SchedulerSettings } from '../server/schedulerSettingDefinitions';
import type { ServiceAction } from './controlService';

type NoFields = Record<never, never>;

export type NativeHostRequestByType = {
  getStatus: NoFields;
  syncCookies: { cookiesJson: string };
  updateSettings: { changes: Partial<SchedulerSettings> };
  getRunHistory: NoFields;
  tailLog: { logName: string; lineCount: number };
  getServices: NoFields;
  controlService: { serviceName: string; action: ServiceAction };
  batch: { requests: NativeHostRequest[] };
};

export type NativeHostRequestType = keyof NativeHostRequestByType;

type NativeHostRequestOfType<Type extends NativeHostRequestType> = {
  type: Type;
} & NativeHostRequestByType[Type];

export type NativeHostRequest = {
  [Type in NativeHostRequestType]: NativeHostRequestOfType<Type>;
}[NativeHostRequestType];

const IS_REQUEST_TYPE_BY_NAME = {
  getStatus: true,
  syncCookies: true,
  updateSettings: true,
  getRunHistory: true,
  tailLog: true,
  getServices: true,
  controlService: true,
  batch: true,
} as const satisfies Record<NativeHostRequestType, true>;

export const NATIVE_HOST_REQUEST_TYPES = Object.keys(
  IS_REQUEST_TYPE_BY_NAME
) as readonly NativeHostRequestType[];

export function isNativeHostRequestType(value: unknown): value is NativeHostRequestType {
  return typeof value === 'string' && Object.hasOwn(IS_REQUEST_TYPE_BY_NAME, value);
}

export function buildNativeHostRequest<Type extends NativeHostRequestType>(
  type: Type,
  fields: NativeHostRequestByType[Type]
): NativeHostRequestOfType<Type> {
  return { type, ...fields };
}
