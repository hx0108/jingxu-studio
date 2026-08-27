import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { _electron as electron, test, type ElectronApplication } from '@playwright/test';

// 真实 DashScope Qwen3-TTS 配音联调探针（v2-voice-audio-timeline §8.2，凭据门控）：
// - 不设 JINGXU_E2E → 文本走真实 QwenTextModelAdapter、TTS 走真实 QwenTtsModelAdapter +
//   生产数据根目录；--no-proxy-server 直连取证（系统代理间歇不可用会表现为网络错误）
// - 同 key 双档：同一把 DASHSCOPE Key 先保证文本档可生成（五阶段 + SHOT_CONTRACT 到
//   READY 分镜），再为配音档 profile-voice-primary 走正式 IPC 存凭据 + testCredential
//   （解密加载校验，零计费请求），随后真实合成若干镜头旁白并选择候选
// - 预算约束：只把前 N 个（默认 3）有台词的镜头喂给整集批量接口；批量建档用显式
//   shotIds 过滤，音色固定 narrator=Neil 默认值，不做逐轮换音色重生成
// - 映射自动填充：真实契约的说话人含 char_* 角色，缺行会被整集批以
//   VOICE_MAPPING_MISSING 拒绝（首跑实录）；探针按注册表音色循环代行用户配置，
//   narrator 行提交默认值属服务层认可的幂等确认
// - 复用旋钮 JINGXU_REAL_TTS_PROJECT_ID：给定已 READY 的项目则跳过建项与文本链，
//   直接进入配音阶段（避免重复烧约 7 分钟文本链成本）
// - 门控：未设 JINGXU_REAL_KEY_FILE / JINGXU_REAL_WORKSPACE_ID 时 skip，避免误触真实 API；
//   JINGXU_REAL_REFRESH_CREDENTIAL=1 时进程内强制重存两档已持久化旧凭据（Key 轮换后复用）
// - 红线：Key 只经 readFile→IPC 进入 safeStorage 密文，全程不回显、不落日志
const desktopRoot = path.resolve(__dirname, '..');
const keyFile = process.env.JINGXU_REAL_KEY_FILE ?? '';
const workspaceId = process.env.JINGXU_REAL_WORKSPACE_ID ?? '';
/** 复用旋钮：给定已 READY 的项目则跳过建项与文本链，直接进入配音阶段（真实计费预算）。 */
const projectIdOverride = process.env.JINGXU_REAL_TTS_PROJECT_ID ?? '';
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;
const VOICE_PROFILE_ID = 'profile-voice-primary';
const MAX_TTS_TARGETS = 3;
/** 角色说话人映射的确定性音色循环（探针代行用户配置；narrator 钉住 Neil 由服务层保证）。 */
const CHARACTER_VOICE_CYCLE = ['Elias', 'Mochi', 'Stella'] as const;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

test('真实 Qwen3-TTS 配音链路探针（五阶段→分镜 READY→音色映射→整集批→候选选择）', async () => {
  test.setTimeout(1_200_000);
  test.skip(!keyFile || !workspaceId, '需要 JINGXU_REAL_KEY_FILE 与 JINGXU_REAL_WORKSPACE_ID');
  const apiKey = (await readFile(keyFile, 'utf8')).replace(/^﻿/, '').replace(/\s+/g, '');

  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [desktopRoot, '--no-proxy-server'],
      env: { ...environment() },
    });
    const page = await application.firstWindow();
    const result = await page.evaluate(
      async ({
        apiKey,
        characterVoiceCycle,
        maxTargets,
        orderedStages,
        pidOverride,
        refreshCredential,
        voiceProfileId,
        wsId,
      }) => {
        type ScriptWorkspaceView = Extract<
          Awaited<ReturnType<typeof window.jingxu.script.getWorkspace>>,
          { ok: true }
        >['data'];

        const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

        // ── Provider 双档配置（零计费面：已配置且不强制轮换时仅读档跳过）──
        const ensureProviders = async (): Promise<{ errorCode: string; step: string } | null> => {
          const profile = await window.jingxu.provider.getProfile({
            profileId: 'profile_qwen_primary',
          });
          if (!profile.ok)
            return { errorCode: profile.error.code, step: 'provider.getProfile(text)' };
          if (!profile.data.configured || refreshCredential) {
            const savedCredential = await window.jingxu.provider.saveCredential({
              apiKey,
              expectedVersionId: profile.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('provider-key'),
            });
            if (!savedCredential.ok)
              return {
                errorCode: savedCredential.error.code,
                step: 'provider.saveCredential(text)',
              };
            const savedWorkspace = await window.jingxu.provider.saveProfile({
              enabled: true,
              expectedVersionId: savedCredential.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('provider-profile'),
              workspaceId: wsId,
            });
            if (!savedWorkspace.ok)
              return { errorCode: savedWorkspace.error.code, step: 'provider.saveProfile(text)' };
            const tested = await window.jingxu.provider.testCredential({
              expectedVersionId: savedWorkspace.data.versionId,
              profileId: 'profile_qwen_primary',
              requestId: requestId('provider-test'),
            });
            if (!tested.ok)
              return { errorCode: tested.error.code, step: 'provider.testCredential(text)' };
          }

          // 配音档：同 Key 双档第二档；testCredential 为解密加载校验，不发请求。
          const voiceProfile = await window.jingxu.provider.getProfile({
            profileId: voiceProfileId,
          });
          if (!voiceProfile.ok)
            return { errorCode: voiceProfile.error.code, step: 'provider.getProfile(voice)' };
          if (!voiceProfile.data.configured || refreshCredential) {
            const savedVoiceCredential = await window.jingxu.provider.saveCredential({
              apiKey,
              expectedVersionId: voiceProfile.data.versionId,
              profileId: voiceProfileId,
              requestId: requestId('provider-key-voice'),
            });
            if (!savedVoiceCredential.ok)
              return {
                errorCode: savedVoiceCredential.error.code,
                step: 'provider.saveCredential(voice)',
              };
            const testedVoice = await window.jingxu.provider.testCredential({
              expectedVersionId: savedVoiceCredential.data.versionId,
              profileId: voiceProfileId,
              requestId: requestId('provider-test-voice'),
            });
            if (!testedVoice.ok)
              return { errorCode: testedVoice.error.code, step: 'provider.testCredential(voice)' };
          }
          return null;
        };

        const waitJobTerminal = async (
          jobId: string,
        ): Promise<{ errorCode?: string | null; finalStatus: string }> => {
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const status = await window.jingxu.job.get({ jobId });
            if (!status.ok) return { finalStatus: `job.get:${status.error.code}` };
            if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
              return { errorCode: status.data.errorCode, finalStatus: status.data.status };
            }
            if (status.data.status === 'SUCCEEDED') return { finalStatus: status.data.status };
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          return { finalStatus: 'TIMEOUT_POLL' };
        };

        // ── 配音阶段（复用档与新建档共用）：READY 核验 → 白名单与默认行断言 →
        //    台词镜头预算截取 → 角色映射自动填充 → 整集批 → 逐镜头等待并选择候选 ──
        const runVoicePhase = async (
          projectId: string,
          readyCandidate: ScriptWorkspaceView,
        ): Promise<{
          batchSkipped: string[];
          batchTargets: number;
          distinctSpeakers: string[];
          errorCode?: string;
          mappingRowsAfter: number;
          mappingRowsBefore: number;
          selectedCandidateId: string | null;
          shotCount: number;
          spokenShotCount: number;
          step?: string;
          synthesized: {
            durationMs: number | null;
            modelId: string;
            shotId: string;
            voiceId: string;
          }[];
        }> => {
          const currentStoryboard = readyCandidate.storyboard.current;
          if (currentStoryboard?.status !== 'READY') {
            return {
              batchSkipped: [],
              batchTargets: 0,
              distinctSpeakers: [],
              mappingRowsAfter: 0,
              mappingRowsBefore: 0,
              selectedCandidateId: null,
              shotCount: readyCandidate.storyboard.shots.length,
              spokenShotCount: 0,
              step: 'storyboard-not-ready',
              synthesized: [],
            };
          }
          const spokenShots = readyCandidate.storyboard.shots.filter((shot) => {
            const document = shot.document as {
              content?: { spoken_text?: string | null };
              dialogue?: { audio_required?: boolean | null };
            };
            return document.dialogue?.audio_required === true && !!document.content?.spoken_text;
          });
          const budgetedShotIds = spokenShots.slice(0, maxTargets).map((shot) => shot.shotId);
          const baseShape = {
            batchSkipped: [] as string[],
            batchTargets: 0,
            selectedCandidateId: null,
            shotCount: readyCandidate.storyboard.shots.length,
            spokenShotCount: spokenShots.length,
            synthesized: [] as {
              durationMs: number | null;
              modelId: string;
              shotId: string;
              voiceId: string;
            }[],
          };
          if (budgetedShotIds.length === 0) {
            return {
              ...baseShape,
              distinctSpeakers: [],
              mappingRowsAfter: 0,
              mappingRowsBefore: 0,
              step: 'no-spoken-shots',
            };
          }

          const mappings = await window.jingxu.voice.getMappings({ projectId });
          if (!mappings.ok)
            return {
              ...baseShape,
              distinctSpeakers: [],
              errorCode: mappings.error.code,
              mappingRowsAfter: 0,
              mappingRowsBefore: 0,
              step: 'voice.getMappings',
            };
          const narratorRow = mappings.data.find((row) => row.speakerId === 'narrator');
          if (narratorRow?.voiceId !== 'Neil') {
            return {
              ...baseShape,
              distinctSpeakers: [],
              mappingRowsAfter: 0,
              mappingRowsBefore: mappings.data.length,
              step: 'narrator-default-missing',
            };
          }
          const rejected = await window.jingxu.voice.saveMapping({
            mappings: [{ speakerId: 'narrator', voiceId: 'Cherry' }],
            projectId,
            requestId: requestId('mapping-bad'),
          });
          if (rejected.ok || rejected.error.code !== 'IPC_INVALID_REQUEST') {
            return {
              ...baseShape,
              distinctSpeakers: [],
              mappingRowsAfter: 0,
              mappingRowsBefore: mappings.data.length,
              step: 'voice-whitelist-not-enforced',
            };
          }

          // 角色说话人映射自动填充：真实分镜 READY 已保证 char_* 均在当前 STORY_BIBLE。
          // narrator 不进集合（台词镜头多为旁白说话人，由显式行覆盖；重复提交被 DTO 拒绝）。
          const distinctSpeakers = [
            ...new Set(
              spokenShots.flatMap((shot) => {
                const document = shot.document as {
                  dialogue?: { speaker_id?: string | null };
                };
                const speakerId = document.dialogue?.speaker_id;
                return speakerId && speakerId !== 'narrator' ? [speakerId] : [];
              }),
            ),
          ].sort();
          const mapped = await window.jingxu.voice.saveMapping({
            mappings: [
              { speakerId: 'narrator', voiceId: 'Neil' },
              // 取模后恒在界内，?? 仅满足 noUncheckedIndexedAccess。
              ...distinctSpeakers.map((speakerId, index) => ({
                speakerId,
                voiceId: characterVoiceCycle[index % characterVoiceCycle.length] ?? '',
              })),
            ],
            projectId,
            requestId: requestId('voice-map'),
          });
          if (!mapped.ok)
            return {
              ...baseShape,
              distinctSpeakers,
              errorCode: mapped.error.code,
              mappingRowsAfter: 0,
              mappingRowsBefore: mappings.data.length,
              step: 'voice.saveMapping',
            };

          const batch = await window.jingxu.voice.generateForEpisode({
            episodeId: readyCandidate.episode.id,
            projectId,
            requestId: requestId('voice-batch'),
            shotIds: budgetedShotIds,
          });
          if (!batch.ok)
            return {
              ...baseShape,
              distinctSpeakers,
              errorCode: batch.error.code,
              mappingRowsAfter: mapped.data.length,
              mappingRowsBefore: mappings.data.length,
              step: 'voice.generateForEpisode',
            };
          if (
            batch.data.targetShotIds.length + batch.data.skippedShots.length !==
            budgetedShotIds.length
          ) {
            return {
              ...baseShape,
              batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
              distinctSpeakers,
              mappingRowsAfter: mapped.data.length,
              mappingRowsBefore: mappings.data.length,
              step: 'voice-batch-partition-broken',
            };
          }

          const synthesized: {
            durationMs: number | null;
            modelId: string;
            shotId: string;
            voiceId: string;
          }[] = [];
          let selectedCandidateId: string | null = null;
          for (const shotId of batch.data.targetShotIds) {
            let done: Awaited<ReturnType<typeof window.jingxu.voice.getGenerations>> | null = null;
            for (let attempt = 0; attempt < 150 && done === null; attempt += 1) {
              const generations = await window.jingxu.voice.getGenerations({ projectId, shotId });
              if (!generations.ok)
                return {
                  ...baseShape,
                  batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
                  batchTargets: batch.data.targetShotIds.length,
                  distinctSpeakers,
                  errorCode: generations.error.code,
                  mappingRowsAfter: mapped.data.length,
                  mappingRowsBefore: mappings.data.length,
                  step: 'voice.getGenerations',
                  synthesized,
                };
              if (generations.data.some((row) => row.status === 'SUCCEEDED')) done = generations;
              else await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (done === null)
              return {
                ...baseShape,
                batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
                batchTargets: batch.data.targetShotIds.length,
                distinctSpeakers,
                mappingRowsAfter: mapped.data.length,
                mappingRowsBefore: mappings.data.length,
                step: 'voice-synthesize-timeout',
                synthesized,
              };
            const succeeded = done.data.find((row) => row.status === 'SUCCEEDED');
            if (succeeded === undefined) continue;
            if (!succeeded.mediaUrl?.startsWith('jingxu://media/')) {
              return {
                ...baseShape,
                batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
                batchTargets: batch.data.targetShotIds.length,
                distinctSpeakers,
                mappingRowsAfter: mapped.data.length,
                mappingRowsBefore: mappings.data.length,
                step: 'voice-url-not-restricted',
                synthesized,
              };
            }
            synthesized.push({
              durationMs: succeeded.durationMs,
              modelId: succeeded.modelId,
              shotId,
              voiceId: succeeded.voiceId,
            });
            if (selectedCandidateId === null) {
              const chosen = await window.jingxu.voice.selectCandidate({
                candidateId: succeeded.id,
                projectId,
                requestId: requestId('voice-select'),
              });
              if (!chosen.ok)
                return {
                  ...baseShape,
                  batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
                  batchTargets: batch.data.targetShotIds.length,
                  distinctSpeakers,
                  errorCode: chosen.error.code,
                  mappingRowsAfter: mapped.data.length,
                  mappingRowsBefore: mappings.data.length,
                  step: 'voice.selectCandidate',
                  synthesized,
                };
              const selectedRow = chosen.data.find((row) => row.id === succeeded.id);
              if (selectedRow?.selectedAt == null)
                return {
                  ...baseShape,
                  batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
                  batchTargets: batch.data.targetShotIds.length,
                  distinctSpeakers,
                  mappingRowsAfter: mapped.data.length,
                  mappingRowsBefore: mappings.data.length,
                  step: 'voice-select-not-reflected',
                  synthesized,
                };
              selectedCandidateId = succeeded.id;
            }
          }
          return {
            batchSkipped: batch.data.skippedShots.map((skip) => skip.reason),
            batchTargets: batch.data.targetShotIds.length,
            distinctSpeakers,
            mappingRowsAfter: mapped.data.length,
            mappingRowsBefore: mappings.data.length,
            selectedCandidateId,
            shotCount: readyCandidate.storyboard.shots.length,
            spokenShotCount: spokenShots.length,
            synthesized,
          };
        };

        // ── 复用档：给 READY 项目直接跳到配音阶段（不重烧文本链）──
        if (pidOverride !== '') {
          const providerError = await ensureProviders();
          if (providerError !== null) return providerError;
          const reused = await window.jingxu.script.getWorkspace({ projectId: pidOverride });
          if (!reused.ok) return { errorCode: reused.error.code, step: 'getWorkspace(reuse)' };
          return { projectId: pidOverride, ...(await runVoicePhase(pidOverride, reused.data)) };
        }

        const created = await window.jingxu.project.create({
          aspectRatio: '9:16',
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          genre: '悬疑',
          name: `真实TTS联调-${String(Date.now())}`,
          requestId: requestId('project'),
          style: '二维漫剧',
          subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
        });
        if (!created.ok) return { step: 'project.create', errorCode: created.error.code };
        const projectId = created.data.id;
        const initialized = await window.jingxu.script.initializeOriginal({
          creativeText: '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客记忆的人。',
          dataProcessingConsent: true,
          projectId,
          requestId: requestId('initialize'),
        });
        if (!initialized.ok)
          return { step: 'script.initializeOriginal', errorCode: initialized.error.code };

        const providerError = await ensureProviders();
        if (providerError !== null) return providerError;

        // ── 五阶段真实文本生成 + 确认 ──
        let workspace = initialized.data;
        const readyIds: Record<string, string> = {};
        const stageResults: unknown[] = [];
        for (const stage of orderedStages) {
          const expectedInputVersionId =
            stage === 'CONCEPT'
              ? workspace.source.id
              : stage === 'STORY_BIBLE'
                ? readyIds.CONCEPT
                : stage === 'EPISODE_OUTLINE'
                  ? readyIds.STORY_BIBLE
                  : stage === 'BEAT_SHEET'
                    ? readyIds.EPISODE_OUTLINE
                    : readyIds.BEAT_SHEET;
          if (expectedInputVersionId === undefined) {
            stageResults.push({ stage, error: 'missing-input' });
            break;
          }
          const queued = await window.jingxu.job.create({
            episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
            expectedInputVersionId,
            idempotencyKey: requestId(`idem-${stage}`),
            operationType: 'GENERATE',
            projectId,
            requestId: requestId(`job-${stage}`),
            stage,
          });
          if (!queued.ok) {
            stageResults.push({ stage, errorCode: queued.error.code });
            break;
          }
          const terminal = await waitJobTerminal(queued.data.id);
          const refreshed = await window.jingxu.script.getWorkspace({ projectId });
          if (!refreshed.ok) {
            stageResults.push({ stage, ...terminal, error: refreshed.error.code });
            break;
          }
          workspace = refreshed.data;
          const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
          stageResults.push({
            draftStatus: draft?.status ?? null,
            stage,
            ...terminal,
          });
          if (terminal.finalStatus !== 'SUCCEEDED' || draft?.status !== 'DRAFT') break;
          const confirmed = await window.jingxu.script.confirmVersion({
            episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
            expectedVersionId: draft.id,
            projectId,
            requestId: requestId(`confirm-${stage}`),
            stage,
            versionId: draft.id,
          });
          if (!confirmed.ok) {
            stageResults.push({ stage, error: `confirm:${confirmed.error.code}` });
            break;
          }
          readyIds[stage] = confirmed.data.id;
        }
        if (readyIds.SCENE_SCRIPT === undefined) {
          return { projectId, stageResults };
        }

        // ── SHOT_CONTRACT 整集分镜 → READY ──
        const queuedShot = await window.jingxu.job.create({
          episodeId: workspace.episode.id,
          expectedInputVersionId: readyIds.SCENE_SCRIPT,
          idempotencyKey: requestId('idem-shot-contract'),
          operationType: 'GENERATE',
          projectId,
          requestId: requestId('job-shot-contract'),
          stage: 'SHOT_CONTRACT',
        });
        if (!queuedShot.ok) {
          stageResults.push({ stage: 'SHOT_CONTRACT', errorCode: queuedShot.error.code });
          return { projectId, stageResults };
        }
        const shotTerminal = await waitJobTerminal(queuedShot.data.id);
        const shotWorkspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!shotWorkspace.ok) return { step: 'getWorkspace(after-shot)', projectId };
        workspace = shotWorkspace.data;
        if (
          shotTerminal.finalStatus !== 'SUCCEEDED' ||
          workspace.storyboard.current?.status !== 'DRAFT'
        ) {
          stageResults.push({ stage: 'SHOT_CONTRACT', ...shotTerminal });
          return { projectId, stageResults };
        }
        const confirmedShot = await window.jingxu.script.confirmVersion({
          episodeId: workspace.episode.id,
          expectedVersionId: workspace.storyboard.current.id,
          projectId,
          requestId: requestId('confirm-shot-contract'),
          stage: 'SHOT_CONTRACT',
          versionId: workspace.storyboard.current.id,
        });
        if (!confirmedShot.ok) {
          return { projectId, stage: 'SHOT_CONTRACT.confirm', errorCode: confirmedShot.error.code };
        }

        const refreshedReady = await window.jingxu.script.getWorkspace({ projectId });
        if (!refreshedReady.ok) return { step: 'getWorkspace(ready)', projectId };
        return {
          projectId,
          stageResults,
          ...(await runVoicePhase(projectId, refreshedReady.data)),
        };
      },
      {
        apiKey,
        characterVoiceCycle: [...CHARACTER_VOICE_CYCLE],
        maxTargets: MAX_TTS_TARGETS,
        orderedStages: [...stages],
        pidOverride: projectIdOverride,
        refreshCredential: process.env.JINGXU_REAL_REFRESH_CREDENTIAL === '1',
        voiceProfileId: VOICE_PROFILE_ID,
        wsId: workspaceId,
      },
    );
    console.log(`REAL_TTS_PROBE_RESULT ${JSON.stringify(result)}`);
    if ('step' in result) throw new Error(result.step);
  } finally {
    await application?.close();
  }
});
