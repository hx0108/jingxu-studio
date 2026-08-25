# Design

结构编辑复用现有 ScriptUnitOfWork；新镜头使用新 shot_id 与 DRAFT ShotContractVersion，旧镜头只更新生命周期。所有集合链接、血缘、head 和审计在同一事务提交；失败由事务协调器整体回滚。
