import type {
  AppResultDto,
  CreateProjectInputDto,
  DeleteProjectInputDto,
  ProjectDetailDto,
  ProjectGetInputDto,
  ProjectListInputDto,
  ProjectListResultDto,
  RestoreProjectInputDto,
  UpdateProjectInputDto,
} from '@jingxu/contracts';

export interface ProjectClient {
  list(input: ProjectListInputDto): Promise<AppResultDto<ProjectListResultDto>>;
  get(input: ProjectGetInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  create(input: CreateProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  update(input: UpdateProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  delete(input: DeleteProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  restore(input: RestoreProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
}

export const getProjectClient = (): ProjectClient => window.jingxu.project;

export const createRequestId = (operation: string): string =>
  `${operation}_${globalThis.crypto.randomUUID()}`;
