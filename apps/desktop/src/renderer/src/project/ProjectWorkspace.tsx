import { useEffect, useMemo, useState } from 'react';

import type { AppErrorDto, ProjectDetailDto, ProjectSummaryDto } from '@jingxu/contracts';

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
import { ProviderSettings } from '../script/ProviderSettings';
import { EvaluationWorkspace } from '../evaluation/EvaluationWorkspace';
import { AppShell, ComingSoonPanel, type GlobalArea } from '../ui/AppShell';

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
  const [screen, setScreen] = useState<Screen>('list');
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
    projects: '我的项目',
    settings: '设置',
    tasks: '生成任务',
    workspace: '创作工作台',
  };

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
      <div className="project-shell">
        <header className="page-header">
          <div>
            <p className="eyebrow">{activeArea === 'workspace' ? '项目创作' : '本地创作空间'}</p>
            <h1>{pageTitle[activeArea]}</h1>
          </div>
          <span className="local-first-badge">仅保存在本机</span>
        </header>
        {commandError !== null && <ProjectErrorBanner error={commandError} />}
        {screen === 'home' && (
          <section className="home-dashboard">
            <div className="hero-card">
              <div>
                <p className="eyebrow">从故事到成片</p>
                <h2>按步骤完成你的下一部 AI 漫剧</h2>
                <p>镜序会保留每个阶段的版本、锁定字段和失败证据，并在每一步告诉你接下来做什么。</p>
              </div>
              <button
                onClick={() => {
                  moveTo(selectedProjectId === null ? 'list' : 'detail');
                }}
                type="button"
              >
                {selectedProjectId === null ? '查看我的项目' : '继续当前项目'}
              </button>
            </div>
            <div className="home-card-grid">
              <article>
                <span>01</span>
                <h3>剧本开发</h3>
                <p>从创意或已有剧本开始，逐阶段确认内容。</p>
              </article>
              <article>
                <span>02</span>
                <h3>分镜设计</h3>
                <p>编辑镜头、管理锁定和检查可生产性。</p>
              </article>
              <article>
                <span>03</span>
                <h3>视频与导出</h3>
                <p>选择候选、调整时间线并导出整集。</p>
              </article>
            </div>
          </section>
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
          <section className="settings-workspace">
            <header>
              <p className="eyebrow">设置</p>
              <h2>模型服务</h2>
              <p>凭据只由主进程安全保存，完整密钥不会回显。</p>
            </header>
            <ProviderSettings onReadyChange={() => undefined} />
          </section>
        )}
        {screen === 'evaluation' && (
          <EvaluationWorkspace
            onBack={() => {
              moveTo(selectedProjectId === null ? 'list' : 'detail');
            }}
            projectId={selectedProjectId}
          />
        )}
        {screen === 'list' && (
          <section>
            <div className="list-toolbar">
              <div aria-label="项目范围" className="segmented-control">
                <button
                  aria-pressed={listScope === 'ACTIVE'}
                  className={listScope === 'ACTIVE' ? 'active' : ''}
                  onClick={() => {
                    setListScope('ACTIVE');
                  }}
                  type="button"
                >
                  我的项目
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
                  data-primary-action
                  onClick={() => {
                    setScreen('create');
                  }}
                  type="button"
                >
                  创建项目
                </button>
              )}
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
              defaults={createProjectFormDefaults()}
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
            <section className="editor-panel script-shell">
              <div className="script-heading">
                <div>
                  <p className="eyebrow">剧本工作区</p>
                  <h2>{currentDetail.name}</h2>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => {
                    moveTo('detail');
                  }}
                  type="button"
                >
                  返回项目
                </button>
              </div>
              <ScriptWorkspaceView
                onCommitted={() => {
                  if (pendingScreen !== null) finishPendingNavigation();
                }}
                onDirtyChange={setDirty}
                onOpenSettings={() => {
                  moveTo('settings');
                }}
                projectId={currentDetail.id}
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
