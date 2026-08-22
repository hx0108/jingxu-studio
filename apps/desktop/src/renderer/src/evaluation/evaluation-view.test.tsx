import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EvaluationWorkspace } from './EvaluationWorkspace';

describe('EvaluationWorkspace — 评测集页面状态矩阵', () => {
  it('全局入口展示筛选、创建、导入、正反例说明与版本化指南', () => {
    const html = renderToStaticMarkup(
      <EvaluationWorkspace onBack={() => undefined} projectId={null} />,
    );

    for (const expected of [
      '全部样本',
      '全局样本',
      '当前项目',
      '导入 JSON 样本',
      '创建样本',
      '规则版本：jingxu-annotation-guideline/1',
      '正在加载评测样本',
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('C:\\');
  });

  it('项目入口提供 READY 门禁派生入口，且不暴露本地路径或数据库入口', () => {
    const html = renderToStaticMarkup(
      <EvaluationWorkspace onBack={() => undefined} projectId="project_12345678" />,
    );

    expect(html).toContain('从当前 READY 分镜派生');
    expect(html).toContain('整集版本 ID');
    for (const forbidden of [
      'sqlite',
      'database',
      'filePath',
      'apiKey',
      'invoke(',
      'send(',
      'on(',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
