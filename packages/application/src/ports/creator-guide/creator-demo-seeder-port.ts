import type { AppResultDto, CreatorDemoResultDto } from '@jingxu/contracts';

/**
 * 五分钟体验种子执行口（simplify-first-run-creator-experience 3.3）。
 *
 * Application 只定义契约与幂等语义；真实种子（项目/五阶段/分镜/参考资产落库、
 * 失败补偿清理）由桌面组合根实现——它才接触 Fixture 文件系统与私有 Mock 运行时。
 * 实现必须满足：
 * - 同一 requestId 重复调用返回 `resumed: true` 与同一演示项目，绝不复制；
 * - 种子任何步骤失败不得遗留半成品项目（补偿清理）；
 * - 种出的项目 `experience_mode = 'DEMO'`，媒体任务只经 Mock 通路；
 * - 全程零 CredentialPort 读取（演示不要求任何凭据）。
 */
export interface CreatorDemoSeederPort {
  seed(requestId: string): Promise<AppResultDto<CreatorDemoResultDto>>;
}
