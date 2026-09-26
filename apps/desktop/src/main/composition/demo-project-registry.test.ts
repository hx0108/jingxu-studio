import { describe, expect, it, vi } from 'vitest';

import { createDemoProjectRegistry } from './demo-project-registry';

describe('demo project registry', () => {
  it('登记多个演示项目—按项目判断—真实项目始终不命中', () => {
    const registry = createDemoProjectRegistry();

    registry.add('project_demo_a');
    registry.add('project_demo_b');

    expect(registry.has('project_demo_a')).toBe(true);
    expect(registry.has('project_demo_b')).toBe(true);
    expect(registry.has('project_real')).toBe(false);
    registry.remove('project_demo_a');
    expect(registry.has('project_demo_a')).toBe(false);
  });

  it('活动项目超过一页且演示项目在后页—启动预载—仍登记演示项目', async () => {
    const registry = createDemoProjectRegistry();
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, index) => ({
          project: {
            experienceMode: 'STANDARD',
            id: `project_standard_${String(index).padStart(3, '0')}`,
          },
        })),
        nextAfter: { id: 'project_standard_099', updatedAt: '2026-09-21T00:00:00.000Z' },
      })
      .mockResolvedValueOnce({
        items: [{ project: { experienceMode: 'DEMO', id: 'project_demo_late' } }],
        nextAfter: null,
      });
    const runtime = {
      getProjectUnitOfWork: () => ({
        run: (work: (repositories: unknown) => Promise<unknown>) =>
          work({ projects: { listPage } }),
      }),
    };

    await registry.prime(runtime as never);

    expect(registry.has('project_demo_late')).toBe(true);
    expect(listPage).toHaveBeenCalledTimes(2);
  });
});
