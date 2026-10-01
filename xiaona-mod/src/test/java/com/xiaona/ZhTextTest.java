package com.xiaona;

import net.minecraft.text.Text;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 死亡消息 / 成就播报的中文渲染。
 * 期望值全部取自官方 1.21.11 zh_cn.json，等于中文客户端看到的写法。
 */
public class ZhTextTest {
    @Test
    public void testLangTableLoaded() {
        assertTrue(ZhText.size() > 1000, "官方中文语言表应已加载，实际 " + ZhText.size() + " 条");
    }

    /** 死亡：%1$s被%2$s杀死了 + 实体名（僵尸） */
    @Test
    public void testDeathMessage() {
        Text t = Text.translatable("death.attack.mob", Text.literal("Steve"),
                Text.translatable("entity.minecraft.zombie"));
        assertEquals("Steve被僵尸杀死了", ZhText.render(t));
    }

    /** 死亡：带武器名的三参数写法 */
    @Test
    public void testDeathMessageWithItem() {
        Text t = Text.translatable("death.attack.player.item", Text.literal("Steve"), Text.literal("Alex"),
                Text.translatable("item.minecraft.diamond_sword"));
        assertEquals("Steve被Alex用钻石剑杀死了", ZhText.render(t));
    }

    /** 死亡：单参数（摔死/烧死等） */
    @Test
    public void testSingleArgDeath() {
        assertEquals("Steve被烧死了", ZhText.render(Text.translatable("death.attack.onFire", Text.literal("Steve"))));
        assertEquals("Steve从高处摔了下来", ZhText.render(Text.translatable("death.fell.accident.generic", Text.literal("Steve"))));
    }

    /** 成就：三种播报格式（任务/目标/挑战） */
    @Test
    public void testAdvancementMessages() {
        Text title = Text.translatable("advancements.story.upgrade_tools.title");
        assertEquals("Steve取得了进度获得升级",
                ZhText.render(Text.translatable("chat.type.advancement.task", Text.literal("Steve"), title)));
        assertEquals("Steve达成了目标获得升级",
                ZhText.render(Text.translatable("chat.type.advancement.goal", Text.literal("Steve"), title)));
        assertEquals("Steve完成了挑战获得升级",
                ZhText.render(Text.translatable("chat.type.advancement.challenge", Text.literal("Steve"), title)));
        assertEquals("Steve取得了进度怪物猎人",
                ZhText.render(Text.translatable("chat.type.advancement.task", Text.literal("Steve"),
                        Text.translatable("advancements.adventure.kill_a_mob.title"))));
    }

    /** 参数可以是字符串而不是 Text */
    @Test
    public void testStringArg() {
        assertEquals("Alex取得了进度获得升级",
                ZhText.render(Text.translatable("chat.type.advancement.task", "Alex",
                        Text.translatable("advancements.story.upgrade_tools.title"))));
    }

    /** 带兄弟节点（前半段是普通文本）时不能吞掉 */
    @Test
    public void testSiblingsAreKept() {
        Text t = Text.literal("[公告] ").append(Text.translatable("death.attack.onFire", Text.literal("Steve")));
        assertEquals("[公告] Steve被烧死了", ZhText.render(t));
    }

    /** 纯字面文本原样返回（游戏公聊走这条） */
    @Test
    public void testLiteralUntouched() {
        assertEquals("<Steve> 大家好", ZhText.render(Text.literal("<Steve> 大家好")));
        assertEquals("", ZhText.render(null));
    }

    /** 查不到中文的键不能抛异常，也不能把整条消息弄丢 */
    @Test
    public void testUnknownKeyDegradesGracefully() {
        Text t = Text.translatable("xiaona.not.a.real.key", Text.literal("Steve"));
        String out = ZhText.render(t);
        assertNotNull(out);
        assertTrue(out.contains("Steve") || out.contains("xiaona"), "至少保留参数或键名，实际: [" + out + "]");

        // 已知模板 + 未知参数：句子结构仍是中文
        Text mixed = Text.translatable("death.attack.mob", Text.literal("Steve"),
                Text.translatable("xiaona.not.a.real.mob"));
        String mixedOut = ZhText.render(mixed);
        assertTrue(mixedOut.startsWith("Steve被") && mixedOut.endsWith("杀死了"),
                "结构应为中文，实际: [" + mixedOut + "]");
    }

    /** 占位符替换：顺序 %s / 带序号 %1$s / %% / 缺参数 / 非 s 说明符 */
    @Test
    public void testSubstitute() {
        assertEquals("A被B杀死了", ZhText.substitute("%1$s被%2$s杀死了", new Object[]{"A", "B"}));
        assertEquals("A取得了进度B", ZhText.substitute("%s取得了进度%s", new Object[]{"A", "B"}));
        assertEquals("A-B", ZhText.substitute("%1$s-%2$s", new Object[]{"A", "B"}));
        assertEquals("A-A", ZhText.substitute("%1$s-%1$s", new Object[]{"A", "B"}));
        assertEquals("完成度 100%", ZhText.substitute("完成度 100%%", new Object[]{}));
        assertEquals("A和", ZhText.substitute("%1$s和%2$s", new Object[]{"A"}), "缺参数留空而不是抛异常");
        assertEquals("A被B杀死%d", ZhText.substitute("%1$s被%2$s杀死%d", new Object[]{"A", "B"}),
                "%d 不认识应原样保留");
    }

    /** 服务端原版输出确实是英文（这就是要做中文化的原因），中文表要比它更中文化 */
    @Test
    public void testServerSideWouldBeEnglish() {
        Text t = Text.translatable("death.attack.mob", Text.literal("Steve"),
                Text.translatable("entity.minecraft.zombie"));
        String vanilla = t.getString();
        String zh = ZhText.render(t);
        assertNotEquals(vanilla, zh, "渲染结果应不同于服务端英文原文");
        assertTrue(vanilla.contains("slain"), "服务端原文应是英文，实际: [" + vanilla + "]");
        assertFalse(zh.contains("slain") || zh.contains("was "), "中文渲染里不应残留英文句式: [" + zh + "]");
        assertTrue(zh.contains("杀死了") && zh.contains("僵尸"), "中文渲染应含官方译法: [" + zh + "]");
    }
}