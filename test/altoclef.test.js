// AltoClef 移植层的单测：任务系统抢占、资源映射、吃饭判定、任务完成后回调
import { describe, it, expect } from 'vitest';
import { Vec3 } from 'vec3';
import altoclefPkg from '../src/mcheadless/altoclef/index.js';
import { TaskRunner } from '../src/mcheadless/altoclef/tasksystem.js';
import { calculateFood, needsToEat } from '../src/mcheadless/altoclef/chains.js';

const { createAltoClef, resolveItem, dropsOfBlock } = altoclefPkg;

function fakeBot({ items = [], ...overrides } = {}) {
  return {
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      elytraFlying: false,
    },
    registry: { blocksByName: { stone: { id: 1 }, diamond_ore: { id: 2 }, sand: { id: 3 } } },
    inventory: { items: () => items },
    food: 20,
    foodSaturation: 5,
    health: 20,
    oxygenLevel: 20,
    pathfinder: { goal: null, setGoal() {}, isMoving: () => false, isMining: () => false },
    players: {},
    entities: {},
    controlState: {},
    blockAt: () => null,
    findBlocks: () => [],
    setControlState() {},
    ...overrides,
  };
}

describe('resolveItem / dropsOfBlock（对照 TaskCatalogue）', () => {
  const registry = { blocksByName: { diamond_ore: { id: 1 }, sand: { id: 2 } } };

  it('物品名能解析到对应矿石方块', () => {
    expect(resolveItem('diamond', registry)).toEqual({
      items: ['diamond'],
      blocks: ['diamond_ore', 'deepslate_diamond_ore'],
    });
  });

  it('方块名直接当物品用（沙子的掉落物还是沙子）', () => {
    expect(resolveItem('sand', registry)).toEqual({ items: ['sand'], blocks: ['sand'] });
  });

  it('未知物品返回 null', () => {
    expect(resolveItem('nonexistent_thing', registry)).toBeNull();
  });

  it('方块掉落物映射', () => {
    expect(dropsOfBlock('stone')).toEqual(['cobblestone']);
    expect(dropsOfBlock('diamond_ore')).toEqual(['diamond']);
    expect(dropsOfBlock('sand')).toEqual(['sand']);
  });
});

describe('吃饭判定（对照 FoodChain.calculateFood / needsToEat）', () => {
  it('饱食度满就不吃', () => {
    expect(needsToEat(20, 20, false, false)).toBe(false);
  });

  it('饿了就吃', () => {
    expect(needsToEat(8, 20, false, false)).toBe(true);
  });

  it('着火了哪怕不太饿也吃', () => {
    expect(needsToEat(19, 20, true, false)).toBe(true);
  });

  it('优先选高饱食度的食物', () => {
    const { units, best } = calculateFood(
      [{ name: 'bread', count: 2 }, { name: 'cooked_beef', count: 1 }],
      10,
      0,
      20,
    );
    expect(units).toBe(10 + 8);
    expect(best.name).toBe('cooked_beef');
  });
});

describe('TaskRunner 优先级（对照 TaskRunner.java）', () => {
  it('高优先级链抢占，低优先级链被中断', () => {
    const mod = { getPos: () => null };
    const runner = new TaskRunner(mod);
    const log = [];
    const low = { isActive: () => true, getPriority: () => 10, tick: () => log.push('low'), stop: () => {}, onInterrupt: () => log.push('low-interrupt') };
    const high = { isActive: () => true, getPriority: () => 100, tick: () => log.push('high'), stop: () => {}, onInterrupt: () => {} };
    runner.addTaskChain(low);
    runner.addTaskChain(high);
    runner.enable();
    runner.tick();
    expect(log).toEqual(['high']);
    expect(runner.getCurrentTaskChain()).toBe(high);
  });
});

describe('createAltoClef：用户任务与回调', () => {
  it('IdleTask 立刻完成并触发 onFinish', () => {
    const bot = fakeBot();
    const alto = createAltoClef(() => bot);
    let finished = false;
    alto.run(new alto.tasks.IdleTask(), 'idle', () => { finished = true; });
    alto.tick();
    expect(finished).toBe(true);
    expect(alto.status().task).toBeNull();
  });

  it('taskForMine 目标数量已满足时返回 IdleTask', () => {
    const bot = fakeBot({ items: [{ name: 'cobblestone', count: 5 }] });
    const alto = createAltoClef(() => bot);
    const task = alto.taskForMine('stone', 5);
    expect(task).toBeInstanceOf(alto.tasks.IdleTask);
  });

  it('taskForGet 解析不了时抛出明确错误', () => {
    const bot = fakeBot();
    const alto = createAltoClef(() => bot);
    expect(() => alto.taskForGet('unknown_item_xyz', 1)).toThrow(/不知道怎么获取/);
  });
});
