import { describe, expect, it, vi } from 'vitest';

import { PRODUCTION_CSP } from './content-security-policy';
import {
  createMainWindowOptions,
  createPermissionRequestHandler,
  createWindowOpenHandler,
  isTrustedAppUrl,
  shouldPreventNavigation,
} from './window-policy';

describe('安全桌面运行时基线', () => {
  it('创建主窗口时—构造配置—强制启用四项安全选项', () => {
    const options = createMainWindowOptions('C:\\jingxu\\preload.js');

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      preload: 'C:\\jingxu\\preload.js',
      sandbox: true,
      webSecurity: true,
    });
  });

  it('页面尝试打开新窗口时—调用窗口策略—始终返回拒绝', () => {
    expect(createWindowOpenHandler()()).toEqual({ action: 'deny' });
  });

  it('页面请求系统权限时—调用权限策略—始终回调拒绝', () => {
    const callback = vi.fn();

    createPermissionRequestHandler()({}, 'camera', callback);

    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('页面发起导航时—比较受信 origin—只允许当前应用 origin', () => {
    expect(isTrustedAppUrl('jingxu://app/index.html', 'jingxu://app')).toBe(true);
    expect(isTrustedAppUrl('jingxu://other/index.html', 'jingxu://app')).toBe(false);
    expect(isTrustedAppUrl('https://example.com', 'jingxu://app')).toBe(false);
    expect(shouldPreventNavigation('https://example.com', 'jingxu://app')).toBe(true);
  });

  it('生产 Renderer 加载时—应用 CSP—拒绝连接、对象和非受信脚本', () => {
    expect(PRODUCTION_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src jingxu:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
  });
});
