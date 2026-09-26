window.JINGXU_DATA = {
  stages: [
    { id: "story", label: "故事构思", number: 1 },
    { id: "script", label: "剧本完善", number: 2 },
    { id: "storyboard", label: "分镜设计", number: 3 },
    { id: "image", label: "画面生成", number: 4 },
    { id: "video", label: "视频生成", number: 5 },
    { id: "composition", label: "合成导出", number: 6 }
  ],
  projects: [
    { title: "午后列车", type: "短剧", stage: "分镜设计", progress: 40, edited: "今天 14:30", tone: "amber" },
    { title: "纸鹤来信", type: "漫剧", stage: "剧本完善", progress: 25, edited: "昨天 20:10", tone: "blue" },
    { title: "夏天的回声", type: "短剧", stage: "画面生成", progress: 65, edited: "9月20日", tone: "green" },
    { title: "远方的站台", type: "漫剧", stage: "画面生成", progress: 80, edited: "9月18日", tone: "violet" },
    { title: "星光下的约定", type: "短剧", stage: "合成导出", progress: 95, edited: "9月15日", tone: "rose" }
  ],
  shots: [
    { id: 1, title: "列车出发", seconds: 15, state: "已完成", tone: "green", dialogue: "列车缓缓启动，新的旅程开始了。" },
    { id: 2, title: "窗边的她", seconds: 15, state: "处理中", tone: "amber", dialogue: "这里的风，真好。" },
    { id: 3, title: "车厢对话", seconds: 15, state: "待生成", tone: "blue", dialogue: "你也是去那边吗？" },
    { id: 4, title: "陌生的陪伴", seconds: 15, state: "待生成", tone: "violet", dialogue: "有时候，陌生人也能成为风景。" },
    { id: 5, title: "窗外的风景", seconds: 15, state: "待生成", tone: "cyan", dialogue: "窗外的阳光，真好看。" },
    { id: 6, title: "新的启程", seconds: 15, state: "待生成", tone: "rose", dialogue: "这趟旅程，我会记得很久。" }
  ],
  candidates: [
    { id: 1, label: "候选一", note: "人物表情自然", tone: "amber" },
    { id: 2, label: "候选二", note: "场景信息完整", tone: "blue" },
    { id: 3, label: "候选三", note: "光线更有氛围", tone: "violet" }
  ],
  sceneText: {
    one: "午后，阳光斜照在城市火车站台。林夏拖着行李箱站在黄线内侧，望向即将停靠的列车。广播提醒旅客有序上车。陈默从人群中走来，两人在车门打开前短暂对视。",
    two: "列车平稳驶离站台。林夏坐在窗边，山川与河流缓缓后退。陈默在对面坐下，把一杯热茶轻轻放在桌上。"
  }
};
