package com.xiaona;

/**
 * 运行时功能开关（游戏内 /xiaona 命令，无需重启）。
 * 只保留桥相关的三项：整机、游戏→本机、本机→游戏。
 */
public class RuntimeToggles {
    /** 整机开关：false 时不推送事件、也不接受注入 */
    public volatile boolean enabled = true;
    /** 游戏聊天/进出服 → 本机 */
    public volatile boolean chatToBridge = true;
    /** 本机 → 游戏（注入文本） */
    public volatile boolean bridgeToChat = true;

    public RuntimeToggles(Config cfg) {
        if (cfg != null && cfg.bridge != null) {
            this.enabled = cfg.bridge.enabled;
        }
    }

    public String status() {
        StringBuilder sb = new StringBuilder();
        sb.append("🔘 桥开关状态：\n");
        sb.append(" 整机: ").append(on(enabled)).append("  (mod)\n");
        sb.append(" 游戏→本机: ").append(on(chatToBridge)).append("  (mcto)\n");
        sb.append(" 本机→游戏: ").append(on(bridgeToChat)).append("  (tomc)\n");
        sb.append("使用：/xiaona on|off  ·  /xiaona <项> on|off  ·  /xiaona list");
        return sb.toString();
    }

    private static String on(boolean v) { return v ? "✅开" : "⛔关"; }

    /** 读取开关当前值；未知项返回 null（键名与 {@link #toggle} 一致） */
    public Boolean get(String what) {
        switch (what == null ? "" : what.toLowerCase()) {
            case "": case "mod": case "整机": case "all":
                return this.enabled;
            case "mcto": case "游戏转发": case "toserver":
                return this.chatToBridge;
            case "tomc": case "本机转发": case "togame":
                return this.bridgeToChat;
            default:
                return null;
        }
    }

    /** 切换并返回新的状态文本；未知项返回 null */
    public String toggle(String what, boolean on) {
        switch (what == null ? "" : what.toLowerCase()) {
            case "": case "mod": case "整机": case "all":
                this.enabled = on;
                return "整机已" + (on ? "开启" : "关闭");
            case "mcto": case "游戏转发": case "toserver":
                this.chatToBridge = on;
                return "游戏→本机 已" + (on ? "开启" : "关闭");
            case "tomc": case "本机转发": case "togame":
                this.bridgeToChat = on;
                return "本机→游戏 已" + (on ? "开启" : "关闭");
            default:
                return null;
        }
    }
}