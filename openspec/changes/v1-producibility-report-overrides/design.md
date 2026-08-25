# Design

报告必须绑定 Episode/Shot 输入版本、ProviderCapabilitySnapshot、ReferencePriceSnapshot 和 rule_set_version。LLM 只能提供 INFO/WARN 建议；BLOCK 只能由确定性规则产生，导出在 BLOCK 清零且 WARN 已确认后继续。
