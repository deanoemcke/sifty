import type { SchedulerSettings } from '../server/schedulerSettingDefinitions';
import type { ServiceAction } from './controlService';

type NoFields = Record<never, never>;

export const MAX_BATCH_REQUEST_COUNT = 8;

// A batch runs its requests concurrently, so it may only hold requests that read state.
export const BATCHABLE_REQUEST_TYPES = [
  'getStatus',
  'getRunHistory',
  'tailLog',
  'getServices',
] as const;

export type BatchableRequestType = (typeof BATCHABLE_REQUEST_TYPES)[number];

export type NativeHostRequestByType = {
  getStatus: NoFields;
  syncCookies: { cookiesJson: string };
  updateSettings: { changes: Partial<SchedulerSettings> };
  getRunHistory: NoFields;
  tailLog: { logName: string; lineCount: number };
  getServices: NoFields;
  controlService: { serviceName: string; action: ServiceAction };
  batch: { requests: BatchableRequest[] };
};

export type NativeHostRequestType = keyof NativeHostRequestByType;

type NativeHostRequestOfType<Type extends NativeHostRequestType> = {
  type: Type;
} & NativeHostRequestByType[Type];

export type BatchableRequest = {
  [Type in BatchableRequestType]: NativeHostRequestOfType<Type>;
}[BatchableRequestType];

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

export function isBatchableRequestType(value: unknown): value is BatchableRequestType {
  return (BATCHABLE_REQUEST_TYPES as readonly unknown[]).includes(value);
}

export function buildNativeHostRequest<Type extends NativeHostRequestType>(
  type: Type,
  fields: NativeHostRequestByType[Type]
): NativeHostRequestOfType<Type> {
  return { type, ...fields };
}
