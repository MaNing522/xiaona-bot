// promptTools.js 的单测：工具清单按身份过滤、权限与运行环境从配置生成。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildToolPrompt } from '../src/promptTools.js';

describe('buildToolPrompt', () => {
  let oldOwner;
  let oldMaster;

  beforeEach(() => {
    oldOwner = process.env.BOT_OWNER;
    oldMaster = process.env.BOT_OWNER_BACKUP;
    process.env.BOT_OWNER = '3804393610';
    process.env.BOT_OWNER_BACKUP = '123456';
  });

  afterEach(() => {
    if (oldOwner === undefined) delete process.env.BOT_OWNER; else process.env.BOT_OWNER = oldOwner;
    if (oldMaster === undefined) delete process.env.BOT_OWNER_BACKUP; else process.env.BOT_OWNER_BACKUP = oldMaster;
  });

  it('普通用户看不到管理员工具', () => {
    const p = buildToolPrompt({ role: 'guest' });
    expect(p).toContain('web_search');
    expect(p).not.toContain('mc_command');
    expect(p).not.toContain('ai_balance');
    expect(p).not.toContain('write_note');
  });

  it('所有者能看到全部工具，且身份与主人 QQ 从配置里来', () => {
    const p = buildToolPrompt({ role: 'owner' });
    expect(p).toContain('mc_command');
    expect(p).toContain('write_note');
    expect(p).toContain('3804393610');
    expect(p).toContain('所有者');
  });

  it('plan 不可用时隐藏 player_query', () => {
    expect(buildToolPrompt({ role: 'guest', caps: { plan: true } })).toContain('player_query');
    expect(buildToolPrompt({ role: 'guest', caps: { plan: false } })).not.toContain('player_query');
  });

  it('配了桥接群与服务器地址时会写进去，没配时说明不转发', () => {
    const on = buildToolPrompt({ serverInfo: '小钠服（mc.example.com）', bridgeGroup: '714965699' });
    expect(on).toContain('mc.example.com');
    expect(on).toContain('714965699');
    expect(on).toContain('/xn');
    expect(buildToolPrompt({})).toContain('当前没有配置游戏桥接群');
  });
});
