// permission.js 的单测：#授权 等级设置（0主人/1管理员/2授权用户/3普通/4黑名单）与黑名单判定。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { init, role, setLevel, isBlacklisted, listAuthorized, listBlacklist, listExtraAdmins, listExtraOwners } from '../permission.js';

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
