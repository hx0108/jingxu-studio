import { describe, expect, it, vi } from 'vitest';

import { createSecureMainWindow } from './create-main-window';

describe('安全主窗口装配', () => {
  it('应用启动时—装配安全窗口—只创建窗口、安装拒绝策略并加载受信 URL', async () => {
    const trace: string[] = [];
    let navigationHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let permissionHandler:
      | ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    let readyToShowHandler: (() => void) | undefined;
    let windowOpenHandler: (() => { action: 'deny' }) | undefined;

    const window = {
      loadURL: vi.fn((url: string) => {
        trace.push(`load:${url}`);
        readyToShowHandler?.();
        return Promise.resolve();
      }),
      once: vi.fn((eventName: 'ready-to-show', handler: () => void) => {
        trace.push(`once:${eventName}`);
        readyToShowHandler = handler;
      }),
      show: vi.fn(() => {
        trace.push('show');
      }),
      webContents: {
        on: vi.fn(
          (
            eventName: 'will-navigate',
            handler: (event: { preventDefault(): void }, url: string) => void,
          ) => {
            trace.push(`on:${eventName}`);
            navigationHandler = handler;
          },
        ),
        setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => {
          trace.push('window-open-handler');
          windowOpenHandler = handler;
        }),
      },
    };

    await createSecureMainWindow({
      createWindow: (options) => {
        trace.push(`create:${String(options.webPreferences?.sandbox)}`);
        return window;
      },
      permissionSession: {
        setPermissionRequestHandler: (handler) => {
          trace.push('permission-handler');
          permissionHandler = handler;
        },
      },
      preloadPath: 'C:\\jingxu\\preload.js',
      trustedUrl: 'jingxu://app/index.html',
    });

    expect(trace).toEqual([
      'create:true',
      'window-open-handler',
      'on:will-navigate',
      'permission-handler',
      'once:ready-to-show',
      'load:jingxu://app/index.html',
      'show',
    ]);
    expect(windowOpenHandler?.()).toEqual({ action: 'deny' });

    const preventDefault = vi.fn();
    navigationHandler?.({ preventDefault }, 'https://example.com');
    expect(preventDefault).toHaveBeenCalledOnce();

    const permissionCallback = vi.fn();
    permissionHandler?.({}, 'camera', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledExactlyOnceWith(false);
    expect(trace.some((entry) => /ipc|shell/iu.test(entry))).toBe(false);
  });
});
