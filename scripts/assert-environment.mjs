const REQUIRED_NODE = Object.freeze({ major: 22, minor: 16 });
const REQUIRED_PNPM_MAJOR = 11;

const parseVersion = (value) => {
  const match = /^(?:v)?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(value);

  if (!match?.groups) {
    throw new Error(`无法解析版本：${value}`);
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
};

const nodeVersion = parseVersion(process.version);
const userAgent = process.env.npm_config_user_agent ?? '';
const pnpmMatch = /^pnpm\/(?<version>\d+\.\d+\.\d+)/u.exec(userAgent);

if (nodeVersion.major !== REQUIRED_NODE.major || nodeVersion.minor < REQUIRED_NODE.minor) {
  throw new Error(
    `需要 Node.js >=22.16.0 <23，当前为 ${process.version}。请停止安装并切换到受支持版本。`,
  );
}

if (!pnpmMatch?.groups) {
  throw new Error('本仓库只支持 pnpm；请勿使用 npm、Yarn 或其他包管理器安装。');
}

const pnpmVersion = parseVersion(pnpmMatch.groups.version);

if (pnpmVersion.major !== REQUIRED_PNPM_MAJOR || pnpmVersion.minor < 16) {
  throw new Error(
    `需要 pnpm >=11.16.0 <12，当前为 ${pnpmMatch.groups.version}。请停止安装并切换到受支持版本。`,
  );
}

console.log(`环境校验通过：Node ${process.version}，pnpm ${pnpmMatch.groups.version}`);
