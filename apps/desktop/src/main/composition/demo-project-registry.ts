import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

/**
 * 进程内唯一 ACTIVE 演示项目登记（simplify-first-run-creator-experience 3.3）。
 *
 * 演示项目仅由演示种子创建（创建时 set），注册期从持久层预载（重启恢复）。
 * 媒体调度器的 resolveModel 回调是同步的：以这里的内存事实按项目路由 Mock
 * 适配器，绝不在调度事务内再开查询。真实项目恒不在表中——零路由。
 */
export interface DemoProjectRegistry {
  readonly current: () => string | null;
  readonly set: (projectId: string | null) => void;
  readonly prime: (runtime: DesktopPersistenceRuntime) => Promise<void>;
}

export const createDemoProjectRegistry = (): DemoProjectRegistry => {
  let current: string | null = null;
  return {
    current: () => current,
    set: (projectId) => {
      current = projectId;
    },
    prime: async (runtime) => {
      const projects = runtime.getProjectUnitOfWork();
      if (projects === null) return;
      await projects.run(async ({ projects: projectRepository }) => {
        const page = await projectRepository.listPage({
          after: null,
          limit: 100,
          scope: 'ACTIVE',
        });
        const demo = page.items.find((item) => item.project.experienceMode === 'DEMO');
        current = demo?.project.id ?? null;
      });
    },
  };
};

/** 组合根共享单例：种子写入、媒体/语音解析读取。 */
export const demoProjectRegistry = createDemoProjectRegistry();
