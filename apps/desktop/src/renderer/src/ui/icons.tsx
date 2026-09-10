// CINE 剪辑台 16px 线性图标：stroke 1.5，viewBox 24，全局导航用。
// 与评审原型 designs/jingxu-studio-redesign/icons.jsx 同源，保持一套气质。
const ICON_PATHS = {
  home: <path d="M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5" />,
  folder: (
    <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
  ),
  clapper: (
    <>
      <path d="M3.5 9h17v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="m4 9 .9-3.6 4 .9-.9 3.4m4.2-3.3 4 .9-.9 3.4m4.2-3.3 3.1.7" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8.5 4.5L12 12.5 3.5 8z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
    </>
  ),
  tasks: (
    <>
      <path d="M9.5 6h11M9.5 12h11M9.5 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 15.5a8 8 0 1 1 16 0" />
      <path d="m12 15.5 3.5-4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h16M4 16h16" />
      <circle cx="9" cy="8" r="1.8" />
      <circle cx="15" cy="16" r="1.8" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICON_PATHS;

export const Icon = ({
  name,
  size = 16,
}: {
  readonly name: IconName;
  readonly size?: number;
}) => (
  <svg
    aria-hidden="true"
    fill="none"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.5}
    viewBox="0 0 24 24"
    width={size}
  >
    {ICON_PATHS[name]}
  </svg>
);
