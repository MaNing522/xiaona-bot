package com.xiaona;

import net.minecraft.text.Text;
import net.minecraft.text.TextContent;
import net.minecraft.text.TranslatableTextContent;

/**
 * 把服务器广播的系统消息归类，挑出要转发到 QQ 的两类：
 * <ul>
 *   <li>{@code death} —— 玩家死亡消息（vanilla 用 {@code death.*} 翻译键）</li>
 *   <li>{@code advancement} —— 成就/进度播报（vanilla 用 {@code chat.type.advancement.*} 翻译键）</li>
 * </ul>
 *
 * 其余乱七八糟的一律不转发（进服退服、{@code /say}、插件公告等）；
 * 本 mod 自己注入的文本是 literal，不带翻译键，也不会被误判。
 *
 * 1.21.11 的两个事实依据：lang 文件里确实存在 chat.type.advancement.task/goal/challenge
 * 与 death.attack.generic / death.fell.* ；DamageTracker 字节码里直接 ldc 了 death.* 常量。
 */
public final class GameMessages {
    private GameMessages() {}

    /** @return "death" / "advancement" / null（不关心） */
    public static String classify(Text text) {
        if (text == null) return null;
        String k = keyOf(text);
        if (k != null) {
            if (k.startsWith("chat.type.advancement.")) return "advancement";
            if (k.startsWith("death.")) return "death";
        }
        // 兼容被外层包一层的写法：真实内容可能挂在子节点上
        try {
            for (Text s : text.getSiblings()) {
                String r = classify(s);
                if (r != null) return r;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 取第一个参数里的玩家名（死亡与进度播报的第一个参数都是玩家名）；取不到返回空串 */
    public static String whoOf(Text text) {
        if (text == null) return "";
        try {
            TextContent c = text.getContent();
            if (c instanceof TranslatableTextContent tc) {
                Object[] args = tc.getArgs();
                if (args != null && args.length > 0) {
                    Object a = args[0];
                    if (a instanceof Text t) return t.getString();
                    if (a instanceof String s) return s;
                }
            }
            for (Text s : text.getSiblings()) {
                String r = whoOf(s);
                if (!r.isEmpty()) return r;
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private static String keyOf(Text t) {
        try {
            TextContent c = t.getContent();
            if (c instanceof TranslatableTextContent tc) return tc.getKey();
        } catch (Exception ignored) {
        }
        return null;
    }
}