import { describe, it, expect } from 'vitest';
import {
  BASE_IPC_RESPONSE_SCHEMA,
  CREATE_ERROR_RESPONSE,
  CREATE_SUCCESS_RESPONSE,
  VALIDATION_ERROR_RESPONSE,
  IPC_ERROR_CODES,
} from '../ipc';

describe('BASE_IPC_RESPONSE_SCHEMA', () => {
  it('validates success response', () => {
    const r = BASE_IPC_RESPONSE_SCHEMA.parse({ success: true, data: { id: 1 } });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: 1 });
  });

  it('validates error response', () => {
    const r = BASE_IPC_RESPONSE_SCHEMA.parse({
      success: false,
      error: { code: 'E001', message: 'failed' },
    });
    expect(r.success).toBe(false);
    expect(r.error!.code).toBe('E001');
  });

  it('rejects invalid success', () => {
    expect(() => BASE_IPC_RESPONSE_SCHEMA.parse({ success: 'yes' })).toThrow();
  });

  it('rejects error without code', () => {
    expect(() =>
      BASE_IPC_RESPONSE_SCHEMA.parse({ success: false, error: { message: 'x' } })
    ).toThrow();
  });

  it('validates meta with uuid traceId', () => {
    const r = BASE_IPC_RESPONSE_SCHEMA.parse({
      success: true,
      meta: { traceId: '550e8400-e29b-41d4-a716-446655440000', timestamp: 1, channel: 't' },
    });
    expect(r.meta!.traceId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('rejects invalid uuid traceId', () => {
    expect(() =>
      BASE_IPC_RESPONSE_SCHEMA.parse({
        success: true,
        meta: { traceId: 'bad', timestamp: 1, channel: 't' },
      })
    ).toThrow();
  });
});

describe('CREATE_ERROR_RESPONSE', () => {
  it('creates error with userIdMessage', () => {
    const r = CREATE_ERROR_RESPONSE('ERR', 'msg', '用户可见');
    expect(r.success).toBe(false);
    expect(r.error.userIdMessage).toBe('用户可见');
  });

  it('omits userIdMessage when not provided', () => {
    const r = CREATE_ERROR_RESPONSE('ERR', 'msg');
    expect(r.error.userIdMessage).toBeUndefined();
  });
});

describe('CREATE_SUCCESS_RESPONSE', () => {
  it('creates typed success response', () => {
    const r = CREATE_SUCCESS_RESPONSE({ id: '1' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ id: '1' });
  });
});

describe('VALIDATION_ERROR_RESPONSE', () => {
  it('returns IPC_VALIDATION_ERROR code', () => {
    const r = VALIDATION_ERROR_RESPONSE('bad params');
    expect(r.error.code).toBe('IPC_VALIDATION_ERROR');
    expect(r.error.userIdMessage).toBe('请求参数校验失败');
  });
});

describe('IPC_ERROR_CODES', () => {
  it('has all expected codes', () => {
    expect(IPC_ERROR_CODES.VALIDATION_ERROR).toBe('IPC_VALIDATION_ERROR');
    expect(IPC_ERROR_CODES.PIPELINE_NOT_FOUND).toBe('PIPELINE_NOT_FOUND');
    expect(IPC_ERROR_CODES.PROVIDER_AUTH_FAILED).toBe('PROVIDER_AUTH_FAILED');
    expect(IPC_ERROR_CODES.UNKNOWN).toBe('UNKNOWN');
  });

  it('has no duplicates', () => {
    const v = Object.values(IPC_ERROR_CODES);
    expect(new Set(v).size).toBe(v.length);
  });
});
