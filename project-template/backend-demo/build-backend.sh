#!/bin/bash
# ============================================================
# build-backend.sh —— 构建模板 demo 后端（零依赖，无需 Maven）
#
# 用法（在 backend-demo/ 目录执行）：
#   ./build-backend.sh
# 产物：backend-demo/demo-backend.jar
# 然后把 jar 复制到壳工程：
#   cp demo-backend.jar ../project-template/web_engine/src/main/resources/resfile/resources/backend/app.jar
#
# 要求：JDK 17+（本脚本用 --release 17 保证鸿蒙 JDK17 可运行）
# ============================================================
set -e
cd "$(dirname "$0")"

echo "[1/3] 编译..."
rm -rf out
mkdir -p out
javac --release 17 -d out src/demo/backend/DemoBackend.java

echo "[2/3] 打包 jar..."
jar --create --file demo-backend.jar --main-class demo.backend.DemoBackend -C out .

echo "[3/3] 验证..."
java -jar demo-backend.jar 8080 &
PID=$!
sleep 1
curl -s http://127.0.0.1:8080/api/hello || true
echo ""
curl -s http://127.0.0.1:8080/api/ping || true
echo ""
kill $PID 2>/dev/null || true

echo "完成：demo-backend.jar 已生成（$(ls -lh demo-backend.jar | awk '{print $5}')）"
echo "下一步：cp demo-backend.jar <壳工程>/web_engine/src/main/resources/resfile/resources/backend/app.jar"
