import { createHash, randomUUID } from 'node:crypto';

import {
  createProjectService,
  createStableHasher,
  type ProjectService,
  type ProjectUnitOfWorkPort,
} from '@jingxu/application';

import { createProjectDirectoryAdapter } from './create-project-directory';

export interface CreateDesktopProjectServiceOptions {
  readonly managedRoot: string;
  readonly unitOfWork: ProjectUnitOfWorkPort;
}

/** Production ProjectService composition; all infrastructure remains injected through Ports. */
export const createDesktopProjectService = ({
  managedRoot,
  unitOfWork,
}: CreateDesktopProjectServiceOptions): ProjectService =>
  createProjectService({
    clock: { now: Date.now },
    directory: createProjectDirectoryAdapter({ managedRoot }),
    hasher: createStableHasher((input) => createHash('sha256').update(input).digest('hex')),
    idGenerator: { newId: (kind = 'project') => `${kind}_${randomUUID()}` },
    unitOfWork,
  });
