/**
 * 项目级角色音色映射仓库端口（v2-voice-audio-timeline design D3）。
 *
 * `narrator` 为固定行（音色恒为注册表旁白默认值，由服务层钉住）；
 * `char_*` 行的合法性（引用当前 STORY_BIBLE 角色、音色在注册表内）由
 * 服务层校验，仓库只负责存取。SQLite 实现随 0020 迁移切片（tasks 4.1）落地。
 */

export interface VoiceMappingRecord {
  readonly projectId: string;
  readonly speakerId: string;
  readonly updatedAt: string;
  readonly voiceId: string;
}

export interface VoiceMappingRepositoryPort {
  listByProject(projectId: string): Promise<readonly VoiceMappingRecord[]>;
  /** 以集合语义整体替换该项目的映射行（含 narrator 固定行）；原子性由实现保证。 */
  replaceAll(
    projectId: string,
    mappings: readonly VoiceMappingRecord[],
  ): Promise<readonly VoiceMappingRecord[]>;
}
