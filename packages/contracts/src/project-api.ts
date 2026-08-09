import type { AppResultDto } from './app-result';
import type {
  CreateProjectInputDto,
  DeleteProjectInputDto,
  ProjectGetInputDto,
  ProjectListInputDto,
  ProjectListResultDto,
  RestoreProjectInputDto,
  UpdateProjectInputDto,
} from './project-command';
import type { ProjectDetailDto } from './project-dto';

/**
 * 六个 Project IPC 的逐方法白名单（Design §2）。
 *
 * 每个 channel 独立注册、输入 strict parse、输出 strict parse、错误归一化为
 * AppResult；Renderer 只能通过此接口调用，不存在通用 invoke/send/on。
 */
export interface ProjectApi {
  /** 按稳定 keyset 分页列出活动/已删除项目。 */
  list(input: ProjectListInputDto): Promise<AppResultDto<ProjectListResultDto>>;
  /** 按 scope 取单个项目详情（current + history）。 */
  get(input: ProjectGetInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  /** 原子创建项目与首个 FormatProfile。 */
  create(input: CreateProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  /** 乐观并发更新项目与 FormatProfile 版本链。 */
  update(input: UpdateProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  /** 二次确认后软删除项目（不级联文件/子表）。 */
  delete(input: DeleteProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
  /** 从回收站恢复项目（事务内重检名称冲突）。 */
  restore(input: RestoreProjectInputDto): Promise<AppResultDto<ProjectDetailDto>>;
}

/** 固定 channel 名，Preload/Main 双端共享（Design §2、§9）。 */
export const PROJECT_IPC_CHANNELS = {
  list: 'project.list',
  get: 'project.get',
  create: 'project.create',
  update: 'project.update',
  delete: 'project.delete',
  restore: 'project.restore',
} as const;
