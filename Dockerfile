# MinePilot 配置面板 (mcai-panel) —— 零依赖 Node 应用
# server.js 仅使用 Node 内置模块，构建时无需 npm install。
FROM node:22-alpine

WORKDIR /app

# 把面板源码打进镜像（server.js / index.html / selftest.js）
COPY mcai-panel/ /app/

ENV PANEL_PORT=25800 \
    TZ=Asia/Shanghai

EXPOSE 25800

# 运行时仍通过卷挂载 ./minecraft-data 与 docker.sock（见 docker-compose.example.yml）
CMD ["node", "/app/server.js"]
