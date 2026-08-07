# 贡献指南

欢迎 PR！提交前请阅读以下要点。

## 开发流程

1. Fork 仓库并创建分支：`git checkout -b feature/your-feature`
2. 安装依赖：`npm install`
3. 启动本地服务：`npm start`
4. 跑测试：`npm test`
5. 提交前确保测试通过
6. 提交时消息清晰：`git commit -m "feat: 增加 XXX"`

## 测试要求

- 所有 PR 必须通过现有测试：`npm test`
- 新功能应配套 e2e 测试（参考 `test/e2e.mjs`）

## 代码风格

- 服务端：Node 标准 ESM (`type: "module"`)，无第三方框架（仅 `ws`）
- 前端：原生 JavaScript（零框架），保持单文件可读
- 中文注释 OK，但代码标识符用英文

## 提交规范

推荐 Conventional Commits：
- `feat:` 新功能
- `fix:` 修 bug
- `docs:` 仅文档
- `refactor:` 重构（无功能变化）
- `test:` 添加/修改测试

## 安全

- **不要**在 PR 中包含真实 token / 密钥 / 密码
- 如果你发现安全问题，请私下联系仓库维护者，而不是开 issue

## 想法收集

- 🌐 多语言 i18n（英文、日文等）
- 🎨 主题（暗色模式、自定义配色）
- 📱 PWA（可安装到桌面）
- 🔐 端到端加密（消息）
- 📞 视频通话扩展