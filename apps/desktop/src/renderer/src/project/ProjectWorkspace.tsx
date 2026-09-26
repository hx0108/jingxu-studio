import { useEffect, useMemo, useState } from 'react';

import type {
  AppErrorDto,
  CreatorNextActionResultDto,
  ProjectDetailDto,
  ProjectSummaryDto,
} from '@jingxu/contracts';

import { useProjectUiStore } from '../store/project-ui-store';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { DirtyLeaveDialog } from './DirtyLeaveDialog';
import { ProjectDetailView } from './ProjectDetail';
import { ProjectFormView, createProjectFormDefaults, type ProjectFormValues } from './ProjectForm';
import { ProjectListView } from './ProjectList';
import { createRequestId } from './project-api';
import { describeProjectError } from './project-error';
import { useProjectCommands, useProjectDetail, useProjectList } from './project-hooks';
import { getTransferClient } from './transfer-api';
import { formatTransferWarnings } from './transfer-copy';
import { ScriptWorkspaceView } from '../script/ScriptWorkspace';
import { ApprovedSettingsWorkspace } from '../script/ApprovedSettingsWorkspace';
import { EvaluationWorkspace } from '../evaluation/EvaluationWorkspace';
import { AppShell, ComingSoonPanel, type GlobalArea } from '../ui/AppShell';
import { WorkspaceTopbar } from '../ui/WorkspaceTopbar';
import { CreatorHome } from './CreatorHome';
import { readCreatorPreferences } from './creator-preferences';
import {
  getCreatorGuideClient,
  routeForCreatorAction,
  type CreatorWorkspaceRoute,
} from './creator-guide-api';

type Screen =
  | 'home'
  | 'list'
  | 'create'
  | 'detail'
  | 'edit'
  | 'script'
  | 'assets'
  | 'tasks'
  | 'exports'
  | 'settings'
  | 'evaluation';
type PendingTarget = Screen | 'close';
interface ConfirmState {
  readonly action: 'delete' | 'restore';
  readonly project: ProjectSummaryDto | ProjectDetailDto;
}

const ProjectErrorBanner = ({ error }: { readonly error: AppErrorDto }) => {
  const view = describeProjectError(error);
  return (
    <section className="notice error-notice" role="alert">
      <h2>{view.summary}</h2>
      <p>{view.nextAction}</p>
      <small>追踪号：{view.traceId}</small>
    </section>
  );
};

/** 百分比表示六步创作流程位置，始终由主进程返回的真实下一动作确定。 */
const creatorProgress = (
  action: CreatorNextActionResultDto,
): { readonly percent: number; readonly stageLabel: string } => {
  const scriptPercent: Readonly<Record<string, number>> = {
    BEAT_SHEET: 42,
    CONCEPT: 14,
    EPISODE_OUTLINE: 32,
    SCENE_SCRIPT: 52,
    STORY_BIBLE: 23,
  };
  const percent =
    action.target === 'START'
      ? 0
      : action.target === 'SOURCE_INPUT'
        ? 5
        : action.target === 'SCRIPT'
          ? (scriptPercent[action.stage ?? ''] ?? 10)
          : action.target === 'STORYBOARD'
            ? 62
            : action.target === 'ASSETS'
              ? 68
              : action.target === 'IMAGE'
                ? 74
                : action.target === 'VIDEO'
                  ? 84
                  : action.target === 'VOICE'
                    ? 90
                    : action.target === 'EXPORT'
                      ? 96
                      : 100;
  return { percent, stageLabel: action.title };
};

export const ProjectWorkspace = () => {
  const {
    selectedProjectId,
    listScope,
    listFilter,
    isDirty,
    select,
    setListScope,
    setListFilter,
    setDirty,
  } = useProjectUiStore();
  const [screen, setScreen] = useState<Screen>('home');
  const [creatorAction, setCreatorAction] = useState<CreatorNextActionResultDto | null>(null);
  const [creatorGuidePending, setCreatorGuidePending] = useState(false);
  const [demoPending, setDemoPending] = useState(false);
  const [creatorGuideError, setCreatorGuideError] = useState<string | null>(null);
  const [projectProgressById, setProjectProgressById] = useState<
    Readonly<Record<string, { readonly percent: number | null; readonly stageLabel: string }>>
  >({});
  const [showStartChoice, setShowStartChoice] = useState(false);
  const [selectedWorkType, setSelectedWorkType] = useState<'漫剧' | '短剧'>(() => {
    const preferred = readCreatorPreferences().defaultType;
    return preferred === '漫剧' ? '漫剧' : '短剧';
  });
  const [creatorRoute, setCreatorRoute] = useState<CreatorWorkspaceRoute | null>(null);
  const [pendingScreen, setPendingScreen] = useState<PendingTarget | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [commandError, setCommandError] = useState<AppErrorDto | null>(null);
  // project-transfer 4.3：列表导入（NEW_PROJECT）回执与在飞状态；取消静默。
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);
  const list = useProjectList(listScope, listFilter.trim());
  const detail = useProjectDetail(
    selectedProjectId === null ? null : { projectId: selectedProjectId, scope: listScope },
  );
  const commands = useProjectCommands();

  const refreshCreatorAction = async (
    projectId: string | null = selectedProjectId,
  ): Promise<CreatorNextActionResultDto | null> => {
    setCreatorGuidePending(true);
    setCreatorGuideError(null);
    try {
      const result = await getCreatorGuideClient().getNextAction({ projectId });
      if (!result.ok) {
        setCreatorGuideError(result.error.userAction ?? '请稍后重试。');
        return null;
      }
      setCreatorAction(result.data);
      return result.data;
    } catch {
      setCreatorGuideError('请检查应用状态后重试。');
      return null;
    } finally {
      setCreatorGuidePending(false);
    }
  };

  useEffect(() => {
    if (screen !== 'home') return;
    // 只在回到首页或显式选择项目时刷新；点击主操作还会二次读取。
    void getCreatorGuideClient()
      .getNextAction({ projectId: selectedProjectId })
      .then((result) => {
        if (!result.ok) {
          setCreatorGuideError(result.error.userAction ?? '请稍后重试。');
          return;
        }
        setCreatorGuideError(null);
        setCreatorAction(result.data);
      })
      .catch(() => {
        setCreatorGuideError('请检查应用状态后重试。');
      });
  }, [screen, selectedProjectId]);

  useEffect(() => {
    document.querySelector<HTMLElement>('.app-content')?.scrollTo({ top: 0 });
  }, [screen]);

  useEffect(() => {
    const blockClose = (event: BeforeUnloadEvent): void => {
      if (!useProjectUiStore.getState().isDirty) return;
      event.preventDefault();
      setPendingScreen('close');
    };
    globalThis.addEventListener('beforeunload', blockClose);
    return () => {
      globalThis.removeEventListener('beforeunload', blockClose);
    };
  }, [screen]);

  const pages = useMemo(() => list.data?.pages ?? [], [list.data?.pages]);
  const listFailure = pages.find((page) => !page.ok);
  const projects = useMemo(
    () => pages.flatMap((page) => (page.ok ? page.data.items : [])),
    [pages],
  );
  const lastPage = pages.at(-1);
  const hasMore = lastPage?.ok === true && lastPage.data.nextCursor !== null;
  const detailResult = detail.data;
  const currentDetail = detailResult?.ok === true ? detailResult.data : null;
  const activeArea: GlobalArea =
    screen === 'home'
      ? 'home'
      : screen === 'evaluation'
        ? 'evaluation'
        : screen === 'assets' || screen === 'tasks' || screen === 'exports' || screen === 'settings'
          ? screen
          : screen === 'detail' || screen === 'edit' || screen === 'script'
            ? 'workspace'
            : 'projects';
  const pageTitle: Readonly<Record<GlobalArea, string>> = {
    assets: '素材库',
    evaluation: '质量与评测',
    exports: '导出记录',
    home: '首页',
    projects: '我的作品',
    settings: '设置',
    tasks: '生成任务',
    workspace: '创作工作台',
  };

  useEffect(() => {
    if (screen !== 'list' || listScope !== 'ACTIVE' || projects.length === 0) return;
    let active = true;
    void Promise.all(
      projects.map(async (project) => {
        try {
          const result = await getCreatorGuideClient().getNextAction({ projectId: project.id });
          return [
            project.id,
            result.ok
              ? creatorProgress(result.data)
              : { percent: null, stageLabel: '阶段读取失败' },
          ] as const;
        } catch {
          return [project.id, { percent: null, stageLabel: '阶段读取失败' }] as const;
        }
      }),
    ).then((entries) => {
      if (active) setProjectProgressById(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [listScope, projects, screen]);

  const moveTo = (target: Screen): void => {
    if (isDirty) {
      setPendingScreen(target);
      return;
    }
    setScreen(target);
  };
  const finishPendingNavigation = (): void => {
    const target = pendingScreen;
    setPendingScreen(null);
    if (target === 'close') {
      globalThis.close();
    } else if (target !== null) {
      setScreen(target);
    }
  };
  const openProject = (project: ProjectSummaryDto): void => {
    select(project.id);
    setScreen('detail');
  };
  const navigateGlobal = (area: GlobalArea): void => {
    const target: Screen =
      area === 'projects'
        ? 'list'
        : area === 'workspace'
          ? selectedProjectId === null
            ? 'list'
            : 'detail'
          : area;
    moveTo(target);
  };

  const continueEpisode = async (): Promise<void> => {
    const latest = await refreshCreatorAction();
    if (latest === null) return;
    if (latest.projectId === null) {
      setShowStartChoice(true);
      return;
    }
    select(latest.projectId);
    const route = routeForCreatorAction(latest);
    if (route === null) {
      setShowStartChoice(true);
      return;
    }
    setCreatorRoute(route);
    moveTo(route.screen);
  };

  const startDemo = async (): Promise<void> => {
    if (demoPending) return;
    setDemoPending(true);
    try {
      const result = await getCreatorGuideClient().startDemo({
        requestId: `demo_${crypto.randomUUID()}`,
      });
      if (!result.ok) {
        setCreatorGuideError(result.error.userAction ?? '示例暂时无法创建，请稍后重试。');
        return;
      }
      // 示例创建会写入真实项目表；立即刷新列表，避免“我的作品”继续展示创建前的空缓存。
      await list.refetch();
      select(result.data.projectId);
      const latest = await refreshCreatorAction(result.data.projectId);
      const route = latest === null ? null : routeForCreatorAction(latest);
      if (!latest?.projectId || route === null) {
        moveTo('detail');
        return;
      }
      setCreatorRoute(route);
      moveTo(route.screen);
    } catch {
      setCreatorGuideError('示例暂时无法创建，请稍后重试。');
    } finally {
      setDemoPending(false);
    }
  };

  const createProject = async (values: ProjectFormValues) => {
    setCommandError(null);
    return commands.create.mutateAsync({
      requestId: createRequestId('create'),
      name: values.name,
      genre: values.genre === '' ? null : values.genre,
      style: values.style === '' ? null : values.style,
      creationMode: values.creationMode,
      dialogueRenderMode: values.dialogueRenderMode,
      aspectRatio: values.aspectRatio,
      subtitleSafeArea: values.subtitleSafeArea,
    });
  };

  const updateProject = async (values: ProjectFormValues) => {
    if (currentDetail === null) throw new Error('Project detail must exist before update.');
    setCommandError(null);
    return commands.update.mutateAsync({
      requestId: createRequestId('update'),
      projectId: currentDetail.id,
      expectedUpdatedAt: currentDetail.updatedAt,
      name: values.name,
      genre: values.genre === '' ? null : values.genre,
      style: values.style === '' ? null : values.style,
      dialogueRenderMode: values.dialogueRenderMode,
      aspectRatio: values.aspectRatio,
      subtitleSafeArea: values.subtitleSafeArea,
    });
  };

  const executeConfirm = async (): Promise<void> => {
    if (confirmState === null) return;
    const { action, project } = confirmState;
    const result =
      action === 'delete'
        ? await commands.deleteProject.mutateAsync({
            requestId: createRequestId('delete'),
            projectId: project.id,
            expectedUpdatedAt: project.updatedAt,
          })
        : await commands.restore.mutateAsync({
            requestId: createRequestId('restore'),
            projectId: project.id,
            expectedUpdatedAt: project.updatedAt,
          });
    if (!result.ok) {
      setCommandError(result.error);
      return;
    }
    setConfirmState(null);
    setDirty(false);
    select(null);
    setScreen('list');
  };

  // 列表导入项目快照（NEW_PROJECT）：文件由 Main Open Dialog 选择（路径不出 Main）。
  const performTransferImport = async (): Promise<void> => {
    if (importPending) return;
    setImportPending(true);
    setCommandError(null);
    setImportNotice(null);
    try {
      const result = await getTransferClient().importProject({
        importMode: 'NEW_PROJECT',
        requestId: createRequestId('transfer-import'),
      });
      if (result.ok) {
        const warnings = formatTransferWarnings(result.data.warningCodes);
        setImportNotice(
          `快照已导入为新项目（${String(result.data.createdObjectCount)} 个对象，来源 ${result.data.sourceProjectId}）${warnings.length > 0 ? `；${warnings.join('；')}` : ''}`,
        );
        await list.refetch();
      } else if (result.error.code !== 'TRANSFER_FILE_CANCELLED') {
        setCommandError(result.error);
      }
    } catch {
      setCommandError({
        code: 'TRANSFER_PERSISTENCE_FAILED',
        fieldErrors: null,
        message: '主进程未返回可验证的结果',
        retryable: true,
        traceId: 'renderer_transport_failure',
        userAction: '请稍后重试。',
      });
    }
    setImportPending(false);
  };

  const pending = commands.deleteProject.isPending || commands.restore.isPending;
  return (
    <AppShell
      activeArea={activeArea}
      onNavigate={navigateGlobal}
      projectName={currentDetail?.name ?? null}
    >
      <div
        className={`${activeArea === 'workspace' ? 'project-shell workspace-area-shell' : 'project-shell'}${screen === 'list' ? ' project-list-shell' : ''}`}
      >
        {screen === 'home' ||
        screen === 'script' ||
        screen === 'settings' ||
        screen === 'evaluation' ? null : activeArea === 'workspace' ? (
          <WorkspaceTopbar
            area={screen === 'edit' ? '编辑创作设定' : '项目概览'}
            context={currentDetail?.name}
          />
        ) : (
          <header className={`page-header${screen === 'list' ? ' project-list-hero' : ''}`}>
            <div>
              <p className="eyebrow">{screen === 'list' ? '继续你的故事创作' : '本地创作空间'}</p>
              <h1>{pageTitle[activeArea]}</h1>
              {screen === 'list' && <p>在这里，继续你的故事创作。</p>}
            </div>
            {screen === 'list' ? (
              <button
                aria-label="创建项目"
                className="project-list-create-button"
                data-primary-action
                onClick={() => {
                  setScreen('create');
                }}
                type="button"
              >
                ✦ 新建作品
              </button>
            ) : (
              <span className="local-first-badge">仅保存在本机</span>
            )}
          </header>
        )}
        {commandError !== null && <ProjectErrorBanner error={commandError} />}
        {screen === 'home' && (
          <CreatorHome
            action={creatorAction}
            demoPending={demoPending}
            error={creatorGuideError}
            onContinue={() => {
              void continueEpisode();
            }}
            onCreate={() => {
              setShowStartChoice(false);
              moveTo('create');
            }}
            onSelectType={setSelectedWorkType}
            onDemo={() => {
              void startDemo();
            }}
            onRetry={() => {
              void refreshCreatorAction();
            }}
            pending={creatorGuidePending}
            projectName={currentDetail?.name}
            showStartChoice={showStartChoice}
          />
        )}
        {screen === 'assets' && (
          <ComingSoonPanel
            title="素材库"
            description="素材仍在各镜头上下文中管理；独立素材库将在后续 Change 实现。"
          />
        )}
        {screen === 'tasks' && (
          <ComingSoonPanel
            title="生成任务"
            description="当前任务状态保留在对应创作阶段；独立任务中心尚未实现。"
          />
        )}
        {screen === 'exports' && (
          <ComingSoonPanel
            title="导出记录"
            description="导出证据目前随项目保存；独立记录页尚未实现。"
          />
        )}
        {screen === 'settings' && (
          <ApprovedSettingsWorkspace
            onBack={() => {
              moveTo(selectedProjectId === null ? 'home' : 'detail');
            }}
          />
        )}
        {screen === 'evaluation' && (
          <EvaluationWorkspace
            isDemo={currentDetail?.experienceMode === 'DEMO'}
            onOpenStoryboard={() => {
              setCreatorRoute({ mediaStep: 'storyboard', screen: 'script', stage: 'SCENE_SCRIPT' });
              moveTo('script');
            }}
            onBack={() => {
              moveTo(selectedProjectId === null ? 'list' : 'detail');
            }}
            projectId={selectedProjectId}
            projectTitle={currentDetail?.name ?? null}
            projectType={currentDetail?.style === '漫剧' ? '漫剧' : '短剧'}
          />
        )}
        {screen === 'list' && (
          <section className="project-list-page">
            <div className="list-toolbar">
              <div aria-label="项目范围" className="segmented-control">
                <button
                  aria-label="我的项目"
                  aria-pressed={listScope === 'ACTIVE'}
                  className={listScope === 'ACTIVE' ? 'active' : ''}
                  onClick={() => {
                    setListScope('ACTIVE');
                  }}
                  type="button"
                >
                  全部作品
                </button>
                <button
                  aria-pressed={listScope === 'DELETED'}
                  className={listScope === 'DELETED' ? 'active' : ''}
                  onClick={() => {
                    setListScope('DELETED');
                  }}
                  type="button"
                >
                  回收站
                </button>
              </div>
              <label>
                筛选项目
                <input
                  onChange={(event) => {
                    setListFilter(event.target.value);
                  }}
                  placeholder="按名称搜索"
                  type="search"
                  value={listFilter}
                />
              </label>
              {listScope === 'ACTIVE' && (
                <button
                  disabled={importPending}
                  name="import-project-snapshot"
                  onClick={() => {
                    void performTransferImport();
                  }}
                  type="button"
                >
                  {importPending ? '正在导入…' : '导入项目快照'}
                </button>
              )}
            </div>
            {importNotice !== null && (
              <p className="action-hint" role="status">
                {importNotice}
              </p>
            )}
            <ProjectListView
              errorMessage={
                listFailure?.ok === false
                  ? describeProjectError(listFailure.error).summary
                  : list.error === null
                    ? undefined
                    : '加载失败，请重试'
              }
              hasFilter={listFilter.trim() !== ''}
              hasMore={hasMore}
              loadingMore={list.isFetchingNextPage}
              onCreate={() => {
                setScreen('create');
              }}
              onLoadMore={() => {
                void list.fetchNextPage();
              }}
              onOpen={openProject}
              onRestore={(project) => {
                setConfirmState({ action: 'restore', project });
              }}
              projects={projects}
              progressByProjectId={projectProgressById}
              scope={listScope}
              state={
                list.isPending
                  ? 'loading'
                  : list.isError || listFailure !== undefined
                    ? 'error'
                    : 'ready'
              }
            />
          </section>
        )}
        {screen === 'create' && (
          <section className="editor-panel">
            <h2>创建项目</h2>
            <ProjectFormView
              defaults={{
                ...createProjectFormDefaults(),
                style:
                  readCreatorPreferences().defaultType === '每次询问'
                    ? selectedWorkType
                    : readCreatorPreferences().defaultType,
                aspectRatio: readCreatorPreferences().defaultAspect === '横屏' ? '16:9' : '9:16',
              }}
              formId="project-editor"
              onCancel={() => {
                moveTo('list');
              }}
              onCommitted={(created) => {
                select(created.id);
                if (pendingScreen === null) setScreen('detail');
                else finishPendingNavigation();
              }}
              onDirtyChange={setDirty}
              onSubmit={createProject}
            />
          </section>
        )}
        {(screen === 'detail' || screen === 'edit' || screen === 'script') &&
          (detail.isPending ? (
            <p aria-live="polite">正在加载项目详情…</p>
          ) : detailResult?.ok === false ? (
            <ProjectErrorBanner error={detailResult.error} />
          ) : currentDetail === null ? (
            <section className="notice error-notice" role="alert">
              找不到项目详情，请返回列表刷新。
            </section>
          ) : screen === 'script' ? (
            <section className="script-shell">
              <ScriptWorkspaceView
                {...(creatorRoute !== null
                  ? {
                      ...(creatorRoute.mediaStep !== null
                        ? { initialMediaStep: creatorRoute.mediaStep }
                        : {}),
                      initialStage: creatorRoute.stage,
                    }
                  : {})}
                onCommitted={() => {
                  if (pendingScreen !== null) finishPendingNavigation();
                }}
                onDirtyChange={setDirty}
                onBack={() => {
                  moveTo('detail');
                }}
                onOpenSettings={() => {
                  moveTo('settings');
                }}
                onOpenProjectSettings={() => {
                  moveTo('edit');
                }}
                onOpenEvaluation={() => {
                  moveTo('evaluation');
                }}
                isDemo={currentDetail.experienceMode === 'DEMO'}
                projectId={currentDetail.id}
                projectName={currentDetail.name}
                workType={currentDetail.style === '漫剧' ? '漫剧' : '短剧'}
              />
            </section>
          ) : screen === 'edit' ? (
            <section className="editor-panel">
              <h2>编辑创作设定</h2>
              <ProjectFormView
                defaults={createProjectFormDefaults(currentDetail)}
                formId="project-editor"
                onCancel={() => {
                  moveTo('detail');
                }}
                onCommitted={() => {
                  setScreen('detail');
                  finishPendingNavigation();
                }}
                onDirtyChange={setDirty}
                onSubmit={updateProject}
                submitLabel="保存更改"
              />
            </section>
          ) : (
            <ProjectDetailView
              detail={currentDetail}
              onDelete={() => {
                setConfirmState({ action: 'delete', project: currentDetail });
              }}
              onEdit={() => {
                setScreen('edit');
              }}
              onRestore={() => {
                setConfirmState({ action: 'restore', project: currentDetail });
              }}
              onOpenScript={() => {
                setScreen('script');
              }}
              onOpenEvaluation={() => {
                setScreen('evaluation');
              }}
            />
          ))}
        <DirtyLeaveDialog
          onCancel={() => {
            setPendingScreen(null);
          }}
          onDiscard={() => {
            setDirty(false);
            finishPendingNavigation();
          }}
          onSaveAndLeave={() => {
            document
              .querySelector<HTMLFormElement>('#project-editor, #script-stage-editor')
              ?.requestSubmit();
          }}
          open={pendingScreen !== null}
          pending={commands.create.isPending || commands.update.isPending}
        />
        <ConfirmActionDialog
          action={confirmState?.action ?? null}
          onCancel={() => {
            setConfirmState(null);
          }}
          onConfirm={() => {
            void executeConfirm();
          }}
          pending={pending}
          projectName={confirmState?.project.name ?? ''}
        />
      </div>
    </AppShell>
  );
};
