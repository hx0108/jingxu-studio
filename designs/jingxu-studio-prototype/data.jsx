const globalAreas = [
  { id: "home", label: "首页", mark: "首" },
  { id: "projects", label: "我的项目", mark: "项" },
  { id: "workspace", label: "创作工作台", mark: "创" },
  { id: "assets", label: "素材库", mark: "素" },
  { id: "tasks", label: "生成任务", mark: "任" },
  { id: "exports", label: "导出记录", mark: "出" },
  { id: "evaluation", label: "质量与评测", mark: "质" },
  { id: "settings", label: "设置", mark: "设" },
];

const productionStages = [
  { id: "input", index: "01", label: "创作输入", status: "done" },
  { id: "script", index: "02", label: "剧本开发", status: "done" },
  { id: "storyboard", index: "03", label: "分镜设计", status: "active" },
  { id: "image", index: "04", label: "画面生成", status: "attention" },
  { id: "video", index: "05", label: "视频生成", status: "active" },
  { id: "composition", index: "06", label: "合成导出", status: "blocked" },
];

const scriptSteps = [
  { id: "concept", label: "故事概念", status: "done" },
  { id: "bible", label: "故事圣经", status: "done" },
  { id: "outline", label: "单集大纲", status: "done" },
  { id: "beats", label: "节拍表", status: "done" },
  { id: "scene", label: "场景剧本", status: "draft" },
];

const shots = [
  { id: 1, title: "清晨的余额提醒", duration: 5, state: "ready", frame: "晨光 / 手机特写", dialogue: "余额到账：8,888,888 元。", camera: "缓慢推近", color: "violet" },
  { id: 2, title: "餐桌上的试探", duration: 7, state: "ready", frame: "餐厅 / 双人中景", dialogue: "今天，也要装作什么都没发生。", camera: "固定镜头", color: "amber" },
  { id: 3, title: "电梯里的陌生人", duration: 6, state: "running", frame: "电梯 / 近景", dialogue: "你每天都在同一时间出门。", camera: "轻微手持", color: "cyan" },
  { id: 4, title: "被跟踪的证据", duration: 8, state: "warning", frame: "地下车库 / 远景", dialogue: "那辆黑车，又出现了。", camera: "横移跟随", color: "rose" },
  { id: 5, title: "办公室的交易", duration: 10, state: "empty", frame: "办公室 / 过肩镜头", dialogue: "钱可以买到安静，但买不到忠诚。", camera: "缓慢环绕", color: "blue" },
  { id: 6, title: "午夜账户冻结", duration: 9, state: "empty", frame: "公寓 / 全景", dialogue: "账户已冻结。", camera: "快速推近", color: "indigo" },
];

const candidateSets = {
  image: [
    { id: "A", label: "构图 A", note: "角色表情准确", selected: true, score: "推荐", color: "violet" },
    { id: "B", label: "构图 B", note: "环境信息更完整", selected: false, score: "备选", color: "cyan" },
    { id: "C", label: "构图 C", note: "光影更戏剧化", selected: false, score: "备选", color: "amber" },
  ],
  video: [
    { id: "V1", label: "视频段 V1", note: "动作自然 · 5.0 秒", selected: true, score: "当前选用", color: "violet" },
    { id: "V2", label: "视频段 V2", note: "运镜更明显 · 5.0 秒", selected: false, score: "备选", color: "blue" },
  ],
};

const statusCopy = {
  active: "进行中",
  attention: "需要处理",
  blocked: "前置条件未满足",
  done: "已完成",
  draft: "草稿",
  empty: "未生成",
  ready: "已确认",
  running: "生成中",
  warning: "建议检查",
};

Object.assign(window, {
  globalAreas,
  productionStages,
  scriptSteps,
  shots,
  candidateSets,
  statusCopy,
});
