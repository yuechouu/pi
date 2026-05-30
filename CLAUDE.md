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

## 项目规则

### 1. 修改源码后必须更新 patch
修改了 `packages/` 下的源码后，必须运行：
```bash
bash patches/save.sh
git add patches/ && git commit -m "chore: update patches"
```

### 2. 主题文件位置
- 内置主题: `packages/coding-agent/src/modes/interactive/theme/dark.json`
- 用户主题: `~/.pi/agent/themes/*.json`
- 当前使用: `~/.pi/agent/themes/claude-code.json`

### 3. 扩展文件位置
- 扩展目录: `~/.pi/agent/extensions/*.ts`
- 模式目录: `~/.pi/agent/modes/`

### 4. 构建和测试
```bash
# 构建
npm run build

# 链接到全局
cd packages/coding-agent && npm link

# 测试
pi
```

### 5. 主题颜色定义
主题颜色定义在两个地方：
- `ThemeJsonSchema` (theme.ts) — JSON schema 验证
- `ThemeColor` 类型 (theme.ts) — TypeScript 类型

添加新颜色时需要同时更新这两处。

### 6. 终端背景色
- 终端背景色由终端配色方案决定，pi-agent 不直接控制
- `export.pageBg` 用于 HTML 导出，不用于终端背景
- 启动时会通过 OSC 11 设置终端背景色（如果主题有 `export.pageBg`）

### 7. Crush 风格
- 工具渲染: `●/✓/×` 图标，无彩色背景
- 输出前缀: `│`
- 左边框: 用户消息紫色，助手消息绿色
- Thinking: 随机 hex 字符串动画（thinking-loader.ts）

### 8. Windows Terminal 配置
- 配置文件: `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`
- Crush 配色方案已添加，背景色 `#18181e`
