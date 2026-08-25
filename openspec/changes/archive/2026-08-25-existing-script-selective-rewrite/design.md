# Design

已有输入在短事务中创建 SourceInput、Consent、Episode、Audit 和 Receipt；SourceInput 原文不可覆盖。改写以 `expectedVersionId` 复检当前 head，按 RFC 6901 write set 产生新 ScriptVersion；锁路径与写集父子/同路径冲突时整次拒绝。
