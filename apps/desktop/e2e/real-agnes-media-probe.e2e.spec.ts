import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');
const gated = process.env.JINGXU_REAL_AGNES_MEDIA_PROBE === '1';

test('真实 AGNES Image→AGNES Video 付费探针', async () => {
  test.setTimeout(1_200_000);
  test.skip(!gated, '需要 JINGXU_REAL_AGNES_MEDIA_PROBE=1');

  const application = await electron.launch({
    args: [desktopRoot, '--no-proxy-server'],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined &&
            name !== 'ELECTRON_RUN_AS_NODE' &&
            name !== 'ELECTRON_FORCE_IS_PACKAGED',
        ),
      ),
      JINGXU_REAL_DEMO_MEDIA_PROBE: '1',
    },
  });

  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async () => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const imageProfile = await window.jingxu.provider.getProfile({
        profileId: 'profile-image-agnes-primary',
      });
      const videoProfile = await window.jingxu.provider.getProfile({
        profileId: 'profile-video-agnes-primary',
      });
      if (!imageProfile.ok || !videoProfile.ok)
        return { step: 'profiles', errorCode: 'PROVIDER_PROFILE_NOT_READY' };
      if (!imageProfile.data.configured || !videoProfile.data.configured)
        return { step: 'profiles', errorCode: 'PROVIDER_CREDENTIAL_MISSING' };
      const demo = await window.jingxu.creatorGuide.startDemo({ requestId: requestId('demo') });
      if (!demo.ok) return { step: 'demo', errorCode: demo.error.code };
      const projectId = demo.data.projectId;
      const workspace = await window.jingxu.script.getWorkspace({ projectId });
      if (!workspace.ok) return { step: 'workspace', errorCode: workspace.error.code, projectId };
      const shotId = workspace.data.storyboard.shots[0]?.shotId;
      if (shotId === undefined) return { step: 'shot-missing', projectId };

      const imageStarted = await window.jingxu.image.generateCandidates({
        projectId,
        requestId: requestId('image'),
        shotId,
      });
      if (!imageStarted.ok)
        return { step: 'image-start', errorCode: imageStarted.error.code, projectId };
      let imagePhase = imageStarted.data.phase;
      for (let attempt = 0; attempt < 600 && imagePhase !== 'COMPLETED'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const task = await window.jingxu.image.getMediaTask({
          projectId,
          taskId: imageStarted.data.id,
        });
        if (!task.ok) return { step: 'image-task', errorCode: task.error.code, projectId };
        imagePhase = task.data.phase;
      }
      const images = await window.jingxu.image.listCandidates({ projectId, shotId });
      if (!images.ok) return { step: 'image-list', errorCode: images.error.code, projectId };
      const image = images.data.find((candidate) => candidate.status === 'SUCCEEDED');
      if (image === undefined)
        return {
          step: 'image-failed',
          imagePhase,
          errors: images.data.map((candidate) => candidate.errorCode),
          projectId,
        };
      const imageSelected = await window.jingxu.image.selectCandidate({
        candidateId: image.id,
        projectId,
        requestId: requestId('image-select'),
      });
      if (!imageSelected.ok)
        return { step: 'image-select', errorCode: imageSelected.error.code, projectId };

      const videoStarted = await window.jingxu.video.generateVideoCandidates({
        projectId,
        requestId: requestId('video'),
        shotId,
      });
      if (!videoStarted.ok)
        return { step: 'video-start', errorCode: videoStarted.error.code, projectId };
      let videoPhase = videoStarted.data.phase;
      for (let attempt = 0; attempt < 900 && videoPhase !== 'COMPLETED'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const task = await window.jingxu.video.getVideoTask({
          projectId,
          taskId: videoStarted.data.id,
        });
        if (!task.ok) return { step: 'video-task', errorCode: task.error.code, projectId };
        videoPhase = task.data.phase;
      }
      const videos = await window.jingxu.video.listVideoCandidates({ projectId, shotId });
      if (!videos.ok) return { step: 'video-list', errorCode: videos.error.code, projectId };
      const video = videos.data.find((candidate) => candidate.status === 'SUCCEEDED');
      if (video === undefined)
        return {
          step: 'video-failed',
          videoPhase,
          errors: videos.data.map((candidate) => candidate.errorCode),
          projectId,
        };
      return {
        imageProvider: imageProfile.data.provider,
        imageStatus: image.status,
        projectId,
        providerKind: video.providerKind,
        videoProvider: videoProfile.data.provider,
        videoStatus: video.status,
      };
    });

    console.log(`REAL_AGNES_MEDIA_RESULT ${JSON.stringify(result)}`);
    expect(result).toMatchObject({
      imageStatus: 'SUCCEEDED',
      imageProvider: 'AGNES_IMAGE',
      providerKind: 'AGNES_VIDEO',
      videoProvider: 'AGNES_VIDEO',
      videoStatus: 'SUCCEEDED',
    });
  } finally {
    await application.close();
  }
});
