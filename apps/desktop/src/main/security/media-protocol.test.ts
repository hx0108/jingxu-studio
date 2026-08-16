import { describe, expect, it, vi } from 'vitest';

import type { MediaStoredFileRef } from '@jingxu/application';

import { handleMediaProtocolRequest, type MediaProtocolDependencies } from './media-protocol';

const REF: MediaStoredFileRef = {
  byteSize: 4,
  mimeType: 'image/png',
  storageRelPath: 'projects/project_00000001/images/ab/abcd.png',
};

const buildDependencies = (
  overrides: Partial<Pick<MediaProtocolDependencies, 'locator'>> = {},
): MediaProtocolDependencies => ({
  locator: {
    findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
    findCandidateMedia: vi.fn(() => Promise.resolve(REF)),
    ...overrides.locator,
  },
  readFile: vi.fn(() => Promise.resolve(Uint8Array.from([1, 2, 3, 4]))),
  resolveWithinProjects: vi.fn(() =>
    Promise.resolve('C:\\managed\\projects\\project_1\\images\\ab\\abcd.png'),
  ),
});

describe('handleMediaProtocolRequest', () => {
  it('合法候选标识—反查解析读盘—200 与 Content-Type，无路径外泄', async () => {
    const dependencies = buildDependencies();
    const response = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(await response.arrayBuffer()).toEqual(Uint8Array.from([1, 2, 3, 4]).buffer);
    expect(dependencies.resolveWithinProjects).toHaveBeenCalledWith(REF.storageRelPath);
  });

  it('资产版本路径—走 findAssetVersionMedia 反查', async () => {
    const dependencies = buildDependencies({
      locator: {
        findAssetVersionMedia: vi.fn(() => Promise.resolve(REF)),
        findCandidateMedia: vi.fn(() => Promise.resolve(null)),
      },
    });
    const response = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/asset-version/assetv_0000001' },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(dependencies.locator.findAssetVersionMedia).toHaveBeenCalledWith('assetv_0000001');
  });

  it('越权标识—短 id、非法字符、注入片段与未知路径形状一律 404—反查零调用', async () => {
    const dependencies = buildDependencies();
    const denied: readonly string[] = [
      'jingxu://media/candidate/short', // 5 字符 < idSchema 下限
      'jingxu://media/candidate/cand_00000001/../../secret', // 路径注入
      'jingxu://media/candidate/cand%2E%2E%2Fsecret', // 编码注入（% 不在 id 字符集）
      'jingxu://media/candidate/cand_00000001/extra', // 多余路径段
      'jingxu://media/other/cand_00000001', // 未知资源段
      'jingxu://media/candidate/', // 缺 id
      'jingxu://evil/candidate/cand_00000001', // 非 media host
    ];
    for (const url of denied) {
      const response = await handleMediaProtocolRequest({ method: 'GET', url }, dependencies);
      expect(response.status, url).toBe(404);
    }
    expect(dependencies.locator.findCandidateMedia).not.toHaveBeenCalled();
    expect(dependencies.locator.findAssetVersionMedia).not.toHaveBeenCalled();
  });

  it('非 GET 方法与未落盘标识（PENDING/FAILED/未知）—统一 404 无细节', async () => {
    const dependencies = buildDependencies();
    const post = await handleMediaProtocolRequest(
      { method: 'POST', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(post.status).toBe(404);

    const miss = buildDependencies({
      locator: {
        findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
        findCandidateMedia: vi.fn(() => Promise.resolve(null)),
      },
    });
    const notStored = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/candidate/cand_00000001' },
      miss,
    );
    expect(notStored.status).toBe(404);
  });

  it('路径解析拒绝（逃逸/符号链接/损坏）与读盘失败—统一 404—响应体零路径零堆栈', async () => {
    const escape = buildDependencies({
      locator: {
        findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
        findCandidateMedia: vi.fn(() =>
          Promise.reject(new Error('C:\\Users\\secret MEDIA_STORE_PATH_ESCAPE at stack')),
        ),
      },
    });
    const locatorThrow = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/candidate/cand_00000001' },
      escape,
    );
    expect(locatorThrow.status).toBe(404);
    expect(await locatorThrow.text()).toBe('Not found');

    const resolveDenied = buildDependencies();
    (resolveDenied.resolveWithinProjects as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('MEDIA_STORE_PATH_ESCAPE'),
    );
    const resolved = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/candidate/cand_00000001' },
      resolveDenied,
    );
    expect(resolved.status).toBe(404);

    const readDenied = buildDependencies();
    (readDenied.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES C:\\'));
    const read = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/candidate/cand_00000001' },
      readDenied,
    );
    expect(read.status).toBe(404);
    expect(await read.text()).toBe('Not found');
  });
});
