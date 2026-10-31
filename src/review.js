export const review = {
  status: 'passed',
  checks: [
    { name: '模型、材质与场景初始化', status: 'passed', evidence: 'docs/review/content-runtime.json：建筑、碰撞体与人物加载完成，sceneLint 无问题，浏览器无运行错误。' },
    { name: '建筑首屏与三方向取景', status: 'passed', evidence: 'docs/review/contact-sheet.png：主体完整，远景场地不再拉大编辑取景，framingReport.ok=true。' },
    { name: '42 秒连续巡场关键帧', status: 'passed', evidence: 'docs/review/tour-modern.png、tour-american.png、tour-dining.png：复查 0/10/20/31/38/39 秒，修正贴脸、侧墙与过亮镜头后复验。' },
    { name: '家具注册与双场景切换', status: 'passed', evidence: 'docs/review/content-runtime.json：5F/6F 共 8 个沙发和床对象注册，材质名称非空，自由漫游场景与人物加载。' },
    { name: '材质、变换、撤销重做与持久化', status: 'passed', evidence: 'docs/review/edit3d-editor-report.json：沙发材质与尺寸、室内灯光均完成修改、撤销、重做和重载恢复；测试后已还原默认值。' },
    { name: 'Work 宿主 SDK 与 Play 漫游', status: 'passed', evidence: 'docs/review/host-report.json、host-walk-play.png：artifactId 匹配，巡场／漫游场景可切换，Play 首帧 HUD 与实际画面完整。' },
  ],
  limitations: ['原生桌面工具栏与 Adreno 真机性能尚未验证；独立漫游的键鼠、碰撞、楼梯和触屏模拟验收另行记录。'],
}
