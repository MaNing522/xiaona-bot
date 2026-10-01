package com.xiaona;

import net.minecraft.text.Text;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 系统消息归类：只认 vanilla 的翻译键，别的都不转发。
 * 用真实的 vanilla 键名（已从 1.21.11 的 en_us.json 与 DamageTracker 字节码核对过）。
 */
public class GameMessagesTest {
    @Test
    public void testDeathMessages() {
        assertEquals("death", GameMessages.classify(Text.translatable("death.attack.generic", "Steve")));
        assertEquals("death", GameMessages.classify(Text.translatable("death.fell.accident.generic", "Steve")));
        assertEquals("death", GameMessages.classify(Text.translatable("death.attack.player", "Steve", "Alex")));
    }

    @Test
    public void testAdvancementMessages() {
        assertEquals("advancement", GameMessages.classify(
                Text.translatable("chat.type.advancement.task", "Steve", Text.literal("石器时代"))));
        assertEquals("advancement", GameMessages.classify(
                Text.translatable("chat.type.advancement.goal", "Steve", Text.literal("我们该去哪儿"))));
        assertEquals("advancement", GameMessages.classify(
                Text.translatable("chat.type.advancement.challenge", "Steve", Text.literal("末地"))));
    }

    /** 进服退服、/say、插件公告、我们自己注入的文本都不该被转发 */
    @Test
    public void testUnrelatedMessagesAreIgnored() {
        assertNull(GameMessages.classify(Text.translatable("multiplayer.player.joined", "Steve")));
        assertNull(GameMessages.classify(Text.translatable("multiplayer.player.left", "Steve")));
        assertNull(GameMessages.classify(Text.translatable("chat.type.announcement", "Server", "hello")));
        // 自己注入的是 literal，不带翻译键 → 不会被再次转发（防回环）
        assertNull(GameMessages.classify(Text.literal("[QQ] Steve: hi")));
        assertNull(GameMessages.classify(Text.literal("")));
    }

    /** 被包一层时也要认出来 */
    @Test
    public void testNestedContentIsDetected() {
        Text nested = Text.literal("前缀").append(Text.translatable("chat.type.advancement.task", "Steve", "X"));
        assertEquals("advancement", GameMessages.classify(nested));
    }

    @Test
    public void testWhoIsExtracted() {
        assertEquals("Steve", GameMessages.whoOf(Text.translatable("death.attack.generic", "Steve")));
        assertEquals("Steve", GameMessages.whoOf(
                Text.translatable("chat.type.advancement.task", Text.literal("Steve"), Text.literal("X"))));
        assertEquals("", GameMessages.whoOf(Text.literal("no args here")));
    }

    @Test
    public void testNullSafety() {
        assertNull(GameMessages.classify(null));
        assertEquals("", GameMessages.whoOf(null));
    }
}