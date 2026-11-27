package com.xiaona;

/**
 * 玩家名规则（支持中文游戏ID）。
 *
 * <p>原版不同版本对名字的字符集要求不一致，桥这边又有多处按名字收参的接口（封禁、Plan 查询等），
 * 所以统一成一条规则：**1~16 个字符，只允许 Unicode 字母、数字、下划线**（长度按码点算，
 * 中文一个字算一个）。ASCII 名字的规则与以前完全一样，只是额外放开了中文/日文/韩文等字母。
 *
 * <p>命令里的中文名（{@code /tp 小明}、{@code @a[name=小明]}、carpet 的 {@code /player 小明 spawn}）
 * 由 {@code mixin/StringReaderMixin} 修；登录名校验由 {@code mixin/PlayerNameMixin} 兜底。
 */
public final class PlayerNames {
    private PlayerNames() {}

    public static boolean valid(String name) {
        if (name == null || name.isEmpty()) return false;
        if (name.codePointCount(0, name.length()) > 16) return false;
        for (int i = 0; i < name.length(); ) {
            int cp = name.codePointAt(i);
            if (cp != '_' && !Character.isLetterOrDigit(cp)) return false;
            i += Character.charCount(cp);
        }
        return true;
    }
}
