#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# MFox AI 视频制作流水线（AnimaHub 核心重构版）云服务器一键更新与重启脚本
# - 零硬编码敏感信息（不保存任何密码、密钥或服务器 IP）
# - 自动探测宝塔 /www/wwwroot、/opt、/data、/srv、/var/www、/root 下的仓库路径
# - 自动拉取最新代码、安装依赖、执行类型检查、构建前端并平滑重启 PM2 / systemd 服务
# ==============================================================================

BRANCH="${GIT_BRANCH:-main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

find_repo_dir() {
  local repo_name="$1"
  local fallback="$2"
  if [[ -n "${fallback}" && -f "${fallback}/package.json" ]]; then
    echo "${fallback}"
    return 0
  fi
  local search_roots=(
    "/www/wwwroot"
    "/opt"
    "/data"
    "/srv"
    "/var/www"
    "/root"
    "$(dirname "${DEFAULT_SERVER_DIR}")"
  )
  for root in "${search_roots[@]}"; do
    if [[ -d "${root}/${repo_name}" && -f "${root}/${repo_name}/package.json" ]]; then
      echo "${root}/${repo_name}"
      return 0
    fi
  done
  return 1
}

SERVER_DIR="${SERVER_DIR:-}"
if [[ -z "${SERVER_DIR}" ]]; then
  if [[ -f "${DEFAULT_SERVER_DIR}/src/index.ts" ]]; then
    SERVER_DIR="${DEFAULT_SERVER_DIR}"
  else
    SERVER_DIR="$(find_repo_dir "mfox-server" "")" || {
      echo "❌ 未找到 mfox-server 目录，请通过 SERVER_DIR=/path/to/mfox-server 指定" >&2
      exit 1
    }
  fi
fi

WEB_DIR="${WEB_DIR:-}"
if [[ -z "${WEB_DIR}" ]]; then
  WEB_DIR="$(find_repo_dir "mfox-web" "$(dirname "${SERVER_DIR}")/mfox-web" || true)"
fi

echo "=================================================="
echo "🚀 开始部署 MFox AI 流水线重构版 (分支: ${BRANCH})"
echo "📦 后端目录: ${SERVER_DIR}"
echo "🌐 前端目录: ${WEB_DIR:-未检测到本地 mfox-web（跳过前端构建）}"
echo "=================================================="

# 1. 更新并校验后端 mfox-server
echo ""
echo "👉 [1/4] 更新后端代码与依赖 (mfox-server)..."
cd "${SERVER_DIR}"
if [[ -d .git ]]; then
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
fi

npm install --no-audit --no-fund
npm run typecheck

# 2. 更新并构建前端 mfox-web (Browser 生产包 -> dist-browser)
if [[ -n "${WEB_DIR}" && -d "${WEB_DIR}" ]]; then
  echo ""
  echo "👉 [2/4] 更新并构建前端 Web 端 (mfox-web)..."
  cd "${WEB_DIR}"
  if [[ -d .git ]]; then
    git fetch origin "${BRANCH}"
    git checkout "${BRANCH}"
    git pull --ff-only origin "${BRANCH}"
  fi
  npm install --ignore-scripts --no-audit --no-fund
  npm run build:browser

  # 若指定了 Nginx 静态站点目录 WEB_STATIC_DIR，则同步构建产物
  if [[ -n "${WEB_STATIC_DIR:-}" && -d "${WEB_STATIC_DIR}" ]]; then
    echo "   同步 dist-browser -> ${WEB_STATIC_DIR}"
    cp -rf "${WEB_DIR}/dist-browser/"* "${WEB_STATIC_DIR}/"
  fi
else
  echo ""
  echo "👉 [2/4] 未检测到 mfox-web 目录，跳过前端构建"
fi

# 3. 平滑重启后端进程（优先匹配 PM2 中指向 SERVER_DIR 的进程，其次匹配名称，否则自动注册）
echo ""
echo "👉 [3/4] 重启 mfox-server 服务（启动时 warmupPool 将自动幂等补齐数据库表与字段）..."
cd "${SERVER_DIR}"
if command -v pm2 >/dev/null 2>&1; then
  PM2_APP_NAME="$(node -e '
    const { execSync } = require("child_process");
    try {
      const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
      const cwd = process.argv[1];
      const hit = list.find(p => p?.pm2_env?.pm_cwd === cwd)
        || list.find(p => /mfox-server|mfox[-_]?api|express-ts-boilerplate/i.test(p?.name || ""));
      if (hit && hit.name) process.stdout.write(String(hit.name));
    } catch {}
  ' "${SERVER_DIR}")"

  if [[ -n "${PM2_APP_NAME}" ]]; then
    echo "   检测到现有 PM2 进程: ${PM2_APP_NAME}，执行重启..."
    pm2 restart "${PM2_APP_NAME}" --update-env
  else
    echo "   未检测到现有 PM2 进程，使用 pm2 启动 mfox-server..."
    pm2 start npm --name "mfox-server" -- start
  fi
  pm2 save >/dev/null 2>&1 || true
elif systemctl list-unit-files 2>/dev/null | grep -q '^mfox-server\.service'; then
  systemctl restart mfox-server.service
else
  echo "⚠️ 未检测到 pm2 或 mfox-server.service，请手动使用进程管理器重启: cd ${SERVER_DIR} && npm start"
fi

if command -v nginx >/dev/null 2>&1; then
  nginx -t >/dev/null 2>&1 && nginx -s reload >/dev/null 2>&1 || true
fi

# 4. 本机端口与新建模能力接口健康自检
echo ""
echo "👉 [4/4] 执行服务健康检查..."
PORT_VAL="3000"
if [[ -f "${SERVER_DIR}/.env" ]]; then
  ENV_PORT="$(grep -E '^PORT=' "${SERVER_DIR}/.env" | tail -n 1 | cut -d'=' -f2- | tr -d ' "\r' || true)"
  if [[ -n "${ENV_PORT}" ]]; then
    PORT_VAL="${ENV_PORT}"
  fi
fi

HEALTH_OK=0
for _ in {1..15}; do
  if curl -fsS "http://127.0.0.1:${PORT_VAL}/pipeline/models/capabilities" >/dev/null 2>&1 \
    || curl -fsS "http://127.0.0.1:${PORT_VAL}/visual-styles" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [[ "${HEALTH_OK}" -eq 1 ]]; then
  echo "✅ 部署完成！mfox-server 已在端口 ${PORT_VAL} 正常响应。"
else
  echo "⚠️ 进程已触发重启，但 15s 内端口 ${PORT_VAL} 尚未就绪，可执行 'pm2 logs' 查看启动日志。"
fi
