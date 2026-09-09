// 统一 16px 线性图标：stroke 1.5，viewBox 24。整套手绘保持一致气质，代替彩色圆框字符标。
function I({ name, size = 16 }) {
  const paths = {
    home: <path d="M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5" />,
    folder: <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />,
    clapper: <><path d="M3.5 9h17v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="m4 9 .9-3.6 4 .9-.9 3.4m4.2-3.3 4 .9-.9 3.4m4.2-3.3 3.1.7" /></>,
    layers: <><path d="m12 3.5 8.5 4.5L12 12.5 3.5 8z" /><path d="m3.5 12.5 8.5 4.5 8.5-4.5" /></>,
    tasks: <><path d="M9.5 6h11M9.5 12h11M9.5 18h11" /><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" /></>,
    export: <><path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5" /><path d="M4.5 19.5h15" /></>,
    gauge: <><path d="M4 15.5a8 8 0 1 1 16 0" /><path d="m12 15.5 3.5-4" /></>,
    sliders: <><path d="M4 8h16M4 16h16" /><circle cx="9" cy="8" r="1.8" /><circle cx="15" cy="16" r="1.8" /></>,
    doc: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12h6M9 15.5h6" /></>,
    image: <><path d="M4 5.5h16v13H4z" /><path d="m4 15 4.5-4 4 3.5 3-2.5L20 15.5" /><circle cx="9" cy="9.5" r="1.2" /></>,
    film: <><path d="M4 5h16v14H4z" /><path d="M8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4" /></>,
    music: <><path d="M9 18V6l9-1.5V16" /><circle cx="7" cy="18" r="2" /><circle cx="16" cy="16" r="2" /></>,
    mic: <><rect x="9.5" y="3.5" width="5" height="10" rx="2.5" /><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5" /></>,
    subs: <><path d="M4 6h16v12H4z" /><path d="M7 13h4M13 13h4M7 15.5h10" /></>,
    lock: <><rect x="6" y="10.5" width="12" height="9" rx="1.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
    play: <path d="M8.5 5.5v13l9-6.5z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    up: <path d="m6 14.5 6-6 6 6" />,
    down: <path d="m6 9.5 6 6 6-6" />,
    left: <path d="M19 12H5m6-6-6 6 6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 3.5v3.6h-3.6" /></>,
    drag: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>,
    scene: <><path d="M4 20h16L14 8l-4 6-2-2z" /><circle cx="16.5" cy="5.5" r="1.2" /></>,
  };
  return (
    <svg
      name={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || null}
    </svg>
  );
}

Object.assign(window, { I });
