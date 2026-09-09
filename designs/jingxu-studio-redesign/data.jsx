// 数据层：沿用经评审验证的内容，新增配音/字幕字段支撑合成屏。
const globalAreas = [
  { id: "home", label: "首页", icon: "home" },
  { id: "projects", label: "我的项目", icon: "folder" },
  { id: "workspace", label: "创作工作台", icon: "clapper" },
  { id: "assets", label: "素材库", icon: "layers" },
  { id: "tasks", label: "生成任务", icon: "tasks" },
  { id: "exports", label: "导出记录", icon: "export" },
  { id: "evaluation", label: "质量与评测", icon: "gauge" },
  { id: "settings", label: "设置", icon: "sliders" },
];

const productionStages = [
  { id: "input", index: "01", cn: "一", label: "创作输入", status: "done" },
  { id: "script", index: "02", cn: "二", label: "剧本开发", status: "done" },
  { id: "storyboard", index: "03", cn: "三", label: "分镜设计", status: "active" },
  { id: "image", index: "04", cn: "四", label: "画面生成", status: "attention" },
  { id: "video", index: "05", cn: "五", label: "视频生成", status: "active" },
  { id: "composition", index: "06", cn: "六", label: "合成导出", status: "blocked" },
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
  { id: 2, title: "餐桌上的试探", duration: 7, state: "ready", locked: true, frame: "餐厅 / 双人中景", dialogue: "今天，也要装作什么都没发生。", camera: "固定镜头", color: "amber" },
  { id: 3, title: "电梯里的陌生人", duration: 6, state: "running", frame: "电梯 / 近景", dialogue: "你每天都在同一时间出门。", camera: "轻微手持", color: "cyan" },
  { id: 4, title: "被跟踪的证据", duration: 8, state: "stale", frame: "地下车库 / 远景", dialogue: "那辆黑车，又出现了。", camera: "横移跟随", color: "rose" },
  { id: 5, title: "办公室的交易", duration: 10, state: "empty", frame: "办公室 / 过肩镜头", dialogue: "钱可以买到安静，但买不到忠诚。", camera: "缓慢环绕", color: "blue" },
  { id: 6, title: "午夜账户冻结", duration: 9, state: "failed", failure: "视频模型响应超时（5×61s）", frame: "公寓 / 全景", dialogue: "账户已冻结。", camera: "快速推近", color: "green" },
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

const voiceSetup = {
  narrator: "沉稳男声 · 云溪",
  bgm: "城市夜行曲.m4a",
  bgmLength: "02:14",
  bgmVolume: "18%",
  subtitle: true,
};

const providers = [
  { kind: "文本模型", icon: "doc", name: "Qwen", model: "qwen-plus", cred: "已安全保存 · 末四位 9821", ok: true },
  { kind: "图片模型", icon: "image", name: "火山方舟 ARK", model: "Seedream 5.0 Lite", cred: "已安全保存 · 末四位 9821", ok: true },
  { kind: "视频模型", icon: "film", name: "火山方舟 ARK", model: "Seedance 2.5", cred: "已安全保存 · 末四位 9821", ok: true },
];

const statusCopy = {
  active: "进行中",
  attention: "需要处理",
  blocked: "前置条件未满足",
  done: "已完成",
  draft: "草稿",
  empty: "未生成",
  failed: "生成失败",
  locked: "已锁定",
  queued: "排队中",
  ready: "已确认",
  running: "生成中",
  stale: "已过期",
  warning: "建议检查",
};

const recentTasks = [
  { icon: "film", title: "视频候选生成 · 镜头 03", state: "running", progress: 64, note: "Seedance 2.5 · 已运行 41s" },
  { icon: "image", title: "首帧候选生成 · 镜头 03", state: "succeeded", note: "3 个候选 · 共 18s" },
  { icon: "film", title: "视频候选生成 · 镜头 06", state: "failed", note: "响应超时 · 可重试" },
  { icon: "image", title: "首帧批量生成 · 剩余镜头", state: "queued", note: "等待视频任务完成" },
];

const pad2 = (value) => String(value).padStart(2, "0");
const secToTc = (sec) => `00:${pad2(Math.floor(sec))}.0`;

Object.assign(window, {
  globalAreas,
  productionStages,
  scriptSteps,
  shots,
  candidateSets,
  voiceSetup,
  providers,
  statusCopy,
  recentTasks,
  pad2,
  secToTc,
});
