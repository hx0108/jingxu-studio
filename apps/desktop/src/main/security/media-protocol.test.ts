import { describe, expect, it, vi } from 'vitest';

import type { MediaStoredFileRef } from '@jingxu/application';

import { handleMediaProtocolRequest, type MediaProtocolDependencies } from './media-protocol';

const REF: MediaStoredFileRef = {
  byteSize: 4,
  mimeType: 'image/png',
  storageRelPath: 'projects/project_00000001/images/ab/abcd.png',
};

const VIDEO_REF: MediaStoredFileRef = {
  byteSize: 4,
  mimeType: 'video/mp4',
  storageRelPath: 'projects/project_00000001/videos/ab/abcd.mp4',
};

const buildDependencies = (
  overrides: Partial<Pick<MediaProtocolDependencies, 'locator'>> = {},
): MediaProtocolDependencies => ({
  locator: {
    findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
    findCandidateMedia: vi.fn(() => Promise.resolve(REF)),
    findVideoCandidateMedia: vi.fn(() => Promise.resolve(null)),
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
        findVideoCandidateMedia: vi.fn(() => Promise.resolve(null)),
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
        findVideoCandidateMedia: vi.fn(() => Promise.resolve(null)),
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
        findVideoCandidateMedia: vi.fn(() => Promise.resolve(null)),
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

  it('视频候选段—走 findVideoCandidateMedia 反查—200 与视频 Content-Type', async () => {
    const dependencies = buildDependencies({
      locator: {
        findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
        findCandidateMedia: vi.fn(() => Promise.resolve(null)),
        findVideoCandidateMedia: vi.fn(() => Promise.resolve(VIDEO_REF)),
      },
    });
    const response = await handleMediaProtocolRequest(
      { method: 'GET', url: 'jingxu://media/video-candidate/vcand_0000001' },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(dependencies.locator.findVideoCandidateMedia).toHaveBeenCalledWith('vcand_0000001');
  });

  it('合法单段 Range—回 206 切片与 Content-Range—前闭后开、开区间与后缀同源', async () => {
    const dependencies = buildDependencies();
    const closed = await handleMediaProtocolRequest(
      { method: 'GET', rangeHeader: 'bytes=1-2', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(closed.status).toBe(206);
    expect(closed.headers.get('Content-Range')).toBe('bytes 1-2/4');
    expect(closed.headers.get('Content-Length')).toBe('2');
    expect(new Uint8Array(await closed.arrayBuffer())).toEqual(Uint8Array.from([2, 3]));

    const openEnded = await handleMediaProtocolRequest(
      { method: 'GET', rangeHeader: 'bytes=2-', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('Content-Range')).toBe('bytes 2-3/4');
    expect(new Uint8Array(await openEnded.arrayBuffer())).toEqual(Uint8Array.from([3, 4]));

    const suffix = await handleMediaProtocolRequest(
      { method: 'GET', rangeHeader: 'bytes=-2', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 2-3/4');

    // end 越总长钳制到最后字节。
    const clamped = await handleMediaProtocolRequest(
      { method: 'GET', rangeHeader: 'bytes=0-99', url: 'jingxu://media/candidate/cand_00000001' },
      dependencies,
    );
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('Content-Range')).toBe('bytes 0-3/4');
  });

  it('越界 Range（起点≥总长/后缀 0）—回 416 与 bytes */total—不回媒体字节', async () => {
    const dependencies = buildDependencies({
      locator: {
        findAssetVersionMedia: vi.fn(() => Promise.resolve(null)),
        findCandidateMedia: vi.fn(() => Promise.resolve(null)),
        findVideoCandidateMedia: vi.fn(() => Promise.resolve(VIDEO_REF)),
      },
    });
    for (const rangeHeader of ['bytes=4-', 'bytes=10-20', 'bytes=-0']) {
      const response = await handleMediaProtocolRequest(
        {
          method: 'GET',
          rangeHeader,
          url: 'jingxu://media/video-candidate/vcand_0000001',
        },
        dependencies,
      );
      expect(response.status, rangeHeader).toBe(416);
      expect(response.headers.get('Content-Range')).toBe('bytes */4');
      // 固定短语无细节（镜像 404 的 'Not found'），绝不回媒体字节。
      expect(await response.text()).toBe('Range Not Satisfiable');
    }
  });

  it('异常 Range（缺前缀/多段/end<start）—回退 200 全量—不报细节', async () => {
    const dependencies = buildDependencies();
    for (const rangeHeader of ['chunks=1-2', 'bytes=abc', 'bytes=', 'bytes=3-1', 'bytes=0-1,2-3']) {
      const response = await handleMediaProtocolRequest(
        {
          method: 'GET',
          rangeHeader,
          url: 'jingxu://media/candidate/cand_00000001',
        },
        dependencies,
      );
      expect(response.status, rangeHeader).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]));
    }
  });
});
