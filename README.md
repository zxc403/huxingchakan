# 3栋51# 建筑漫游

可编辑的六层建筑可视化与实时漫游工程。包含参数化 Blender 源文件、Edit3D 双场景、独立 Three.js 漫游应用、碰撞体、人物动画和完整验收证据。

## 空间与装修

- **1F**：独立入户大堂。
- **5F**：按用户提供的三张 GTA 截图适配黑白灰现代装修与家具。
- **2F–4F**：复制 5F 的现代主题。
- **6F**：美式轻奢；奶白布艺沙发、黑胡桃木家具、白色乳胶漆与美式护墙板、水晶灯、花艺窗帘、3000K 暖光。
- **6F 地面**：用户指定的米白高抛光大理石、深棕金色双线和卷草花拼花，不是木地板。

户型、交通核和外轮廓以用户提供的 PDF 为依据，两户不强制镜像。详见 `docs/design-brief.md`。

## 工程入口

| 内容 | 路径 |
|---|---|
| Blender 参数化源文件 | `building-51.blend` |
| Blender 重建脚本 | `build.py` |
| Edit3D 项目入口 | `src/project.js` |
| 建筑巡场 | `src/scene.js`、`src/building.js` |
| 自由漫游 | `src/walk.js`、`src/player.js` |
| 独立漫游入口模板 | `pages/index.template` |
| 标准建筑 GLB | `public/models/model.glb` |
| ASTC 4×4 建筑 GLB | `public/models/model-astc.glb` |
| 低模碰撞体 | `public/models/collision.glb` |
| 22 骨人物与四个动作 | `public/models/character.glb` |
| 纹理来源清单 | `docs/texture-manifest.json` |
| 验收证据 | `docs/review/` |

`pages/index.html` 是有意不保留的临时文件。独立漫游开发或构建时由 `tools/pages-vite.mjs` 生成，结束后自动删除，避免 Edit3D 扫描到独立 WebGPU 入口而发生依赖预构建冲突。

## 本地运行

要求 Node.js 22.12 或更高版本。交付机已使用 Node.js 24.21.0 验证。

```bash
npm install
npm run dev
```

打开终端输出的 Scene preview 地址。项目包含“建筑巡场”和“自由漫游”两个场景；在自由漫游中进入 Play 后即可操作。

独立漫游：

```bash
npm run pages:dev
```

生产构建与检查：

```bash
npm run check
npm run build
npm run pages:build
# 如需预览独立漫游构建：
npm run pages:preview
# 如需运行 Edit3D 服务构建：
npm start
```

### 漫游操作

- 键盘：`WASD` 移动、鼠标环顾、`Shift` 奔跑、短按空格跳跃、`V` 切换第一／第三人称、`1`–`6` 传送楼层。
- 触屏：左侧摇杆移动、右侧滑动环顾，以及奔跑和跳跃按钮。
- 可从 1F 通过真实双跑楼梯步行到 2F；墙体和家具有碰撞，开放门洞可穿行。

## 模型与纹理

最终 GLB 重导入检查结果见 `docs/verification-glb.json`：

- 建筑：478,352 三角面、331 个 Mesh、54 个材质、27 张内嵌纹理。
- 碰撞体：12,936 三角面，独立于视觉模型。
- 人物：22 骨，动作恰好为 `idle`、`walk`、`run`、`jump`。
- 标准 `model.glb`：23,956,048 字节，使用可移植 JPEG/PNG 纹理。
- `model-astc.glb`：22,416,308 字节，真正的 ASTC 4×4 与 mipmaps；SHA-256 为 `5aaa3ec970b0dfd62165329c71e13122edf4ff273480c2ebfcead1b276dcf17b`。

独立漫游只在 WebGPU adapter 或 WebGL 扩展确实支持 ASTC 时加载 ASTC 版本，否则回退标准版。本机 Edge 已实际回退标准版并加载全部 27 张纹理。主墙等运行颜色纹理为 1K，法线／ARM 为 512，卷草花拼花为 1600 × 1800；详见 `docs/texture-optimization.json`。

## 验收状态

最终复验已通过：

- Edit3D 材质名称、对象选择、材质改色、家具缩放、灯光参数、撤销／重做、保存并重载恢复；测试后全部还原默认值。
- Work 隔离宿主中的 artifactId、双场景切换、Play 首帧 HUD 与实际漫游画面。
- 1F–6F 传送、行走、奔跑、跳跃与落地、第一／第三人称、内墙碰撞、开放门洞和真实楼梯通行。
- 强制 WebGL2、18:30 时段、触屏摇杆／跳跃与横竖屏布局。
- `npm run check`、`npm run build`、`npm run pages:build`。

本轮实测性能：桌面 WebGPU 交互验收约 15–34 FPS；WebGL2 6F 状态约 19 FPS；触屏模拟采样约 22–43 FPS；Work 宿主截图时 HUD 为 26 FPS。帧率随视角和场景变化，这些数据不是手机真机成绩。

**未验证项**：Adreno 或其他手机真机性能、手机 60 FPS 目标、原生桌面工具栏／IPC。Work 验收使用 `offscreen-validation`，不能据此声称原生桌面集成已通过。验收时未发现既有桌面预览容器，因此没有伪造“已同步”结论。

报告与截图位于 `docs/review/`；完整测试脚本和原始输出保留在任务工作区的 `verification/`。

## GitHub Pages

`.github/workflows/pages.yml` 用于构建并部署独立漫游，而不是 Edit3D 编辑器。推送到 `main` 后，工作流使用 GitHub 提供的 `GITHUB_TOKEN`，不需要把个人访问密钥写入仓库。

Pages 的公开 URL 只有在远程推送、仓库 Pages 设置和 Actions 部署都成功后才可用。私有仓库能否使用 Pages 取决于 GitHub 方案；不要仅为部署而擅自改为公开。

## 来源与许可

见 `docs/credits.md`。用户提供的 PDF、截图、视频和拼花参考仅标记为“用户提供”，不推定额外许可。
