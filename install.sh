#!/bin/bash
# 安装依赖并初始化项目

echo "========================================"
echo "  多智能体协作平台 - 安装脚本"
echo "========================================"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js 未安装，请先安装 Node.js >= 18"
    exit 1
fi
echo "[OK] Node.js $(node --version)"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo "[ERROR] npm 未安装"
    exit 1
fi
echo "[OK] npm $(npm --version)"

# 安装依赖
echo ""
echo "正在安装依赖..."
npm install

# 创建必要的运行时目录
mkdir -p tasks logs/agents logs/events logs/analytics workspace

# 初始化 tasks/index.json
if [ ! -f tasks/index.json ]; then
    echo "[]" > tasks/index.json
fi

echo ""
echo "========================================"
echo "  安装完成！"
echo "  运行 npm start 启动平台"
echo "  然后访问 http://localhost:3000"
echo "========================================"
