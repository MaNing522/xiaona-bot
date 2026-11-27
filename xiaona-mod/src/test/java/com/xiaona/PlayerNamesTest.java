package com.xiaona;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 玩家名规则：中文可用，长度/字符集仍受限。 */
class PlayerNamesTest {
    @Test
    void acceptsAsciiAndChinese() {
        assertTrue(PlayerNames.valid("Steve"));
        assertTrue(PlayerNames.valid("a"));
        assertTrue(PlayerNames.valid("小明"));
        assertTrue(PlayerNames.valid("小钠_01"));
        assertTrue(PlayerNames.valid("日本語の名前"));
        assertTrue(PlayerNames.valid("一".repeat(16)));
    }

    @Test
    void rejectsBadNames() {
        assertFalse(PlayerNames.valid(null));
        assertFalse(PlayerNames.valid(""));
        assertFalse(PlayerNames.valid("has space"));
        assertFalse(PlayerNames.valid("小明!"));
        assertFalse(PlayerNames.valid("小明 小红"));
        assertFalse(PlayerNames.valid("a".repeat(17)));
        assertFalse(PlayerNames.valid("一".repeat(17)));
    }
}
