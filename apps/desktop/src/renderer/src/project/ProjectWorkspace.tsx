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
import { ScriptWorkspaceView } from '../script/ScriptWorkspace';

type Screen = 'list' | 'create' | 'detail' | 'edit' | 'script';
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

  const pending = commands.deleteProject.isPending || commands.restore.isPending;
  return (
    <main className="project-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">JINGXU STUDIO</p>
          <h1>镜序 Studio</h1>
        </div>
        <nav aria-label="项目导航">
          <button
            className={listScope === 'ACTIVE' ? 'active-tab' : 'secondary-button'}
            onClick={() => {
              moveTo('list');
              setListScope('ACTIVE');
            }}
            type="button"
          >
            项目
          </button>
          <button
            className={listScope === 'DELETED' ? 'active-tab' : 'secondary-button'}
            onClick={() => {
              moveTo('list');
              setListScope('DELETED');
            }}
            type="button"
          >
            回收站
          </button>
        </nav>
      </header>
      {commandError !== null && <ProjectErrorBanner error={commandError} />}
      {screen === 'list' && (
        <section>
          <div className="list-toolbar">
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
          </div>
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
                <p className="eyebrow">SCRIPT WORKSPACE</p>
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
    </main>
  );
};
