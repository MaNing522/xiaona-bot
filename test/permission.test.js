// permission.js 的单测：#授权 等级设置（0主人/1管理员/2授权用户/3普通/4黑名单）与黑名单判定。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { init, role, setLevel, setLevelBy, canManage, isBlacklisted, listAuthorized, listBlacklist, listExtraAdmins, listExtraOwners } from '../permission.js';

const ENV_OWNER = '1000';
const ENV_ADMIN = '2000';
let dir;
let savedOwner;
let savedAdmins;

beforeEach(() => {
  savedOwner = process.env.BOT_OWNER;
  savedAdmins = process.env.BOT_ADMINS;
  process.env.BOT_OWNER = ENV_OWNER;
  process.env.BOT_ADMINS = ENV_ADMIN;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-perm-'));
  init(dir);
});

afterEach(() => {
  process.env.BOT_OWNER = savedOwner;
  process.env.BOT_ADMINS = savedAdmins;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('setLevel（#授权 等级设置）', () => {
  it('2 → 授权用户', () => {
    const r = setLevel('3001', 2);
    expect(r.ok).toBe(true);
    expect(role('3001')).toBe('authorized');
    expect(listAuthorized()).toContain('3001');
  });

  it('1 → 管理员；0 → 主人', () => {
    setLevel('3001', 1);
    expect(role('3001')).toBe('admin');
    expect(listExtraAdmins()).toContain('3001');
    setLevel('3001', 0);
    expect(role('3001')).toBe('owner');
    expect(listExtraOwners()).toContain('3001');
  });

  it('3 → 普通用户（从其他名单移除）', () => {
    setLevel('3001', 2);
    expect(role('3001')).toBe('authorized');
    const r = setLevel('3001', 3);
    expect(r.ok).toBe(true);
    expect(role('3001')).toBe('guest');
    expect(listAuthorized()).not.toContain('3001');
  });

  it('4 → 黑名单：不再是任何身份，且被标记', () => {
    setLevel('3001', 1);
    setLevel('3001', 4);
    expect(role('3001')).toBe('guest');
    expect(isBlacklisted('3001')).toBe(true);
    expect(listExtraAdmins()).not.toContain('3001');
    expect(listBlacklist()).toContain('3001');
  });

  it('切换等级会从上一个名单移除', () => {
    setLevel('3001', 2);
    setLevel('3001', 4);
    setLevel('3001', 2);
    expect(isBlacklisted('3001')).toBe(false);
    expect(listAuthorized()).toContain('3001');
    expect(listBlacklist()).not.toContain('3001');
  });

  it('非法等级 → 失败', () => {
    expect(setLevel('3001', 9).ok).toBe(false);
    expect(setLevel('3001', -1).ok).toBe(false);
  });

  it('.env 写死的主人/管理员不能被命令降级', () => {
    expect(setLevel(ENV_OWNER, 2).ok).toBe(false);
    expect(setLevel(ENV_ADMIN, 3).ok).toBe(false);
    expect(role(ENV_OWNER)).toBe('owner');
    expect(role(ENV_ADMIN)).toBe('admin');
  });

  it('等级落盘：重新 init 后仍生效', () => {
    setLevel('3001', 4);
    init(dir);
    expect(isBlacklisted('3001')).toBe(true);
    setLevel('3002', 2);
    init(dir);
    expect(role('3002')).toBe('authorized');
  });
});

describe('setLevelBy / canManage（管理员及以上受限放权）', () => {
  it('主人不受限：可设任意等级', () => {
    expect(setLevelBy(ENV_OWNER, '3001', 1).ok).toBe(true);
    expect(role('3001')).toBe('admin');
    expect(setLevelBy(ENV_OWNER, '3001', 2).ok).toBe(true);
    expect(role('3001')).toBe('authorized');
  });

  it('管理员只能设「低于自己」的等级（2/3/4），不能授予 0/1', () => {
    expect(setLevelBy(ENV_ADMIN, '3001', 0).ok).toBe(false);
    expect(setLevelBy(ENV_ADMIN, '3001', 1).ok).toBe(false);
    expect(setLevelBy(ENV_ADMIN, '3001', 2).ok).toBe(true);
    expect(role('3001')).toBe('authorized');
    expect(setLevelBy(ENV_ADMIN, '3001', 4).ok).toBe(true);
    expect(isBlacklisted('3001')).toBe(true);
  });

  it('管理员不能改动同级或更高（主人/管理员），也不能改自己', () => {
    setLevel('3001', 1); // 另一个管理员
    expect(setLevelBy(ENV_ADMIN, ENV_OWNER, 4).ok).toBe(false);
    expect(setLevelBy(ENV_ADMIN, '3001', 4).ok).toBe(false);
    expect(setLevelBy(ENV_ADMIN, ENV_ADMIN, 2).ok).toBe(false);
  });

  it('授权用户/普通用户无权执行', () => {
    expect(setLevelBy('3001', '3002', 2).ok).toBe(false); // 普通用户
    expect(canManage('3001', '3002').ok).toBe(false);
  });
});
