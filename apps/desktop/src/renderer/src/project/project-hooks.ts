import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CreateProjectInputDto,
  DeleteProjectInputDto,
  ProjectGetInputDto,
  ProjectListScope,
  RestoreProjectInputDto,
  UpdateProjectInputDto,
} from '@jingxu/contracts';

import { projectKeys } from '../lib/query-client';
import { getProjectClient } from './project-api';

export const useProjectList = (scope: ProjectListScope, search: string) =>
  useInfiniteQuery({
    queryKey: projectKeys.list(scope, search),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      getProjectClient().list({
        scope,
        search: search === '' ? null : search,
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page) => (page.ok ? page.data.nextCursor : null),
  });

export const useProjectDetail = (input: ProjectGetInputDto | null) =>
  useQuery({
    queryKey: input === null ? projectKeys.detail('none') : projectKeys.detail(input.projectId),
    enabled: input !== null,
    queryFn: () =>
      input === null
        ? Promise.reject(new Error('Project detail query cannot run without an input.'))
        : getProjectClient().get(input),
  });

export const useProjectCommands = () => {
  const client = useQueryClient();
  const invalidate = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: projectKeys.all });
  };
  return {
    create: useMutation({
      mutationFn: (input: CreateProjectInputDto) => getProjectClient().create(input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (input: UpdateProjectInputDto) => getProjectClient().update(input),
      onSuccess: invalidate,
    }),
    deleteProject: useMutation({
      mutationFn: (input: DeleteProjectInputDto) => getProjectClient().delete(input),
      onSuccess: invalidate,
    }),
    restore: useMutation({
      mutationFn: (input: RestoreProjectInputDto) => getProjectClient().restore(input),
      onSuccess: invalidate,
    }),
  };
};
