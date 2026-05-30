# Pi Agent (Fork) - Claude Instructions

## 项目概述

这是 pi-agent 的 fork 版本，添加了 Crush 风格 UI 和自定义更新机制。

## 关键路径

- **上游**: https://github.com/earendil-works/pi
- **Fork**: https://github.com/yuechouu/pi
- **npm**: pi-coding-agent-yuechouu

## 开发流程

### 修改源码后
```bash
bash patches/save.sh
git add patches/ && git commit -m "chore: update patches"
```

### 同步上游
```bash
bash patches/sync-upstream.sh
```

### 发版
```bash
# 更新 package.json 版本号
npm install --ignore-scripts
node scripts/generate-coding-agent-shrinkwrap.mjs
git add -A && git commit -m "chore: bump version to x.x.x"
git tag vx.x.x
git push origin main && git push origin vx.x.x
```

## Patch 文件

- `crush-tools.patch` — 工具渲染（稳定）
- `crush-ui.patch` — UI/扩展（可能冲突）
- `custom-update.patch` — 更新机制（稳定）

## 代理设置

GitHub 推送需要代理：
```bash
git -c http.proxy=http://127.0.0.1:33210 -c https.proxy=http://127.0.0.1:33210 push origin main
```
