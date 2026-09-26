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
      '导入样本文件',
      '创建样本',
      '规则版本：第 1 版',
      '正在加载评测样本',
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('C:\\');
  });

  it('项目入口提供已确认门禁派生入口，且不暴露本地路径或数据库入口', () => {
    const html = renderToStaticMarkup(
      <EvaluationWorkspace
        onBack={() => undefined}
        projectId="project_12345678"
        projectTitle="午后列车"
        projectType="短剧"
      />,
    );

    expect(html).toContain('从当前已确认分镜派生');
    expect(html).toContain('整集版本标识');
    expect(html).toContain('全部');
    expect(html).toContain('漫剧');
    expect(html).toContain('短剧');
    expect(html).toContain('完成评测并生成报告');
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

  it('演示项目以原型三栏信息层级展示作品进度、镜头和可执行检查结果', () => {
    const html = renderToStaticMarkup(
      <EvaluationWorkspace
        isDemo
        onBack={() => undefined}
        onOpenStoryboard={() => undefined}
        projectId="project_12345678"
        projectTitle="午后列车"
        projectType="短剧"
      />,
    );

    for (const expected of [
      '共 6 个镜头',
      '已检查 5 / 6 个镜头',
      '列车出发',
      '窗边的她',
      '场景与光线连续',
      '返回镜头修改',
      '检查下一个镜头',
      '演示数据',
    ]) {
      expect(html).toContain(expected);
    }
  });
});
