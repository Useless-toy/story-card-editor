export function multiRoleFixture() {
  const roles = Array.from({ length: 200 }, (_, i) => ({
    id: 'actor-' + i, name: '人物' + String(i).padStart(3, '0'),
    tier: i < 60 ? 'cast' : i < 100 ? 'support' : 'extra', aliases: ['别名' + i],
    where: i < 8 ? 'A市大学' : 'B市研究所',
    profile: ('角色档案' + i + '。' + '喜欢阅读，独立思考，遵守约定。'.repeat(20)).slice(0, 195).padEnd(195, '。') + '档案终点。',
    stats: i < 100 ? [{ key: '信任', default: 20 }, { key: '警觉', default: 0 }] : []
  }))
  return {
    id: 'stress-200', title: '多人场景验证', subtitle: '本地测试', hint: '只用于验证引擎', roles,
    setting: { place: 'A市大学', duration: '一天', rule: '依据事实推进剧情。\n\n不可读取他人私事。\n\n保留玩家决定权。', castPolicy: { maxOnStage: 8, alwaysOnStage: ['actor-0'], contextBudgetChars: 24000 } },
    playerFields: [{ key: 'name', label: '姓名', type: 'text' }],
    toggle: { label: '测试', optionTitle: '测试', optionDesc: '测试选项' },
    routes: [{ id: 'start', name: '校园', scene: '你在A市大学图书馆前停下。人物000至人物007正在等你。', stats: { 'actor-0': { 信任: 28 } } }, { id: 'custom', name: '自由', custom: true }],
    turnPanels: { mode: 'custom', protocol: '只依据本轮发生的行动更新数值，并保留其他字段。输出正文、状态面板与行动选择。', panels: ['当前情况', '在场名单', '成员状态'] },
    worldBook: [{ key: '大学', tag: '场景', value: '图书馆十点关门，校园车辆禁止进入步行道。' }]
  }
}
