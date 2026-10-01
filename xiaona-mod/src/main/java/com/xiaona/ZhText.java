package com.xiaona;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.text.PlainTextContent;
import net.minecraft.text.Text;
import net.minecraft.text.TextContent;
import net.minecraft.text.TranslatableTextContent;
import net.minecraft.util.Language;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 死亡消息 / 成就播报的中文化（只作用于推给 QQ 的文本）。
 *
 * 为什么不能直接用 {@link Text#getString()}：服务端 jar 里只有 en_us.json，
 * 服务端解析永远出英文（实测 {@code Steve was slain by Zombie} / {@code Getting an Upgrade}）；
 * 中文只在各玩家客户端按自己的语言渲染，服务端拿不到。
 *
 * 所以这里自带一份从官方 1.21.11 zh_cn.json 抽出的中文语言表
 * （mod 资源 assets/xiaona/lang/zh_cn.json：death / entity / item / advancements / chat.type.advancement），
 * 按 Text 结构递归渲染；查不到的中文键退回原版英文模板（参数仍尽量译成中文）。
 */
public final class ZhText {
    private static final String RES_PATH = "assets/xiaona/lang/zh_cn.json";

    private static volatile Map<String, String> table = null;
    private static volatile boolean loaded = false;

    private ZhText() {}

    /** 语言表条数；0 = 没加载成功（死亡/成就将保持英文） */
    public static int size() {
        load();
        Map<String, String> t = table;
        return t == null ? 0 : t.size();
    }

    private static void load() {
        if (loaded) return;
        synchronized (ZhText.class) {
            if (loaded) return;
            Map<String, String> map = null;
            try (InputStream in = open()) {
                if (in == null) {
                    BotState.error("[中文] 未找到语言表 " + RES_PATH + "，死亡/成就将保持英文。");
                } else {
                    String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                    map = new Gson().fromJson(json, new TypeToken<Map<String, String>>() {}.getType());
                    if (map == null || map.isEmpty()) map = null;
                }
            } catch (Exception e) {
                BotState.error("[中文] 语言表解析失败：" + e.getMessage());
            }
            table = map == null ? null : new HashMap<>(map);
            loaded = true;
        }
    }

    /** 优先按 mod 资源定位（开发/正式环境都可靠），退回 classpath */
    private static InputStream open() {
        try {
            Optional<Path> p = FabricLoader.getInstance().getModContainer("xiaona")
                    .flatMap(c -> c.findPath(RES_PATH));
            if (p.isPresent() && Files.exists(p.get())) return Files.newInputStream(p.get());
        } catch (Exception ignored) {
        }
        return ZhText.class.getResourceAsStream("/" + RES_PATH);
    }

    /** 渲染成中文；任何异常都退回原版英文，绝不让转发本身失败 */
    public static String render(Text text) {
        if (text == null) return "";
        load();
        try {
            return renderText(text);
        } catch (Exception e) {
            try {
                return text.getString();
            } catch (Exception e2) {
                return "";
            }
        }
    }

    private static String renderText(Text t) {
        StringBuilder sb = new StringBuilder(renderContent(t.getContent()));
        for (Text sibling : t.getSiblings()) sb.append(renderText(sibling));
        return sb.toString();
    }

    private static String renderContent(TextContent content) {
        if (content instanceof TranslatableTextContent tc) return renderTranslatable(tc);
        if (content instanceof PlainTextContent pc) return pc.string();
        return "";
    }

    private static String renderTranslatable(TranslatableTextContent tc) {
        String key = tc.getKey();
        Object[] args = tc.getArgs();

        Map<String, String> t = table;
        String pattern = t == null ? null : t.get(key);
        if (pattern == null) {
            // 没有中文（模组自定义消息等）：用原版英文模板，参数仍尽量译成中文
            try {
                pattern = Language.getInstance().get(key);
            } catch (Exception ignored) {
            }
        }
        if (pattern == null) return "";
        if (args == null || args.length == 0) return pattern;

        Object[] rendered = new Object[args.length];
        for (int i = 0; i < args.length; i++) rendered[i] = renderArg(args[i]);
        return substitute(pattern, rendered);
    }

    private static String renderArg(Object arg) {
        if (arg == null) return "";
        if (arg instanceof Text t) return renderText(t);
        return String.valueOf(arg);
    }

    /**
     * 占位符替换，同时支持顺序 {@code %s} 与带序号 {@code %1$s} 两种写法
     * （官方中文用 {@code %1$s}，英文用 {@code %1$s}/{@code %s} 混用），
     * 并处理 {@code %%}。不认识的形式原样保留，不做抛异常的强解析。
     */
    static String substitute(String pattern, Object[] args) {
        StringBuilder out = new StringBuilder(pattern.length() + 16);
        int auto = 0;
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c != '%' || i + 1 >= pattern.length()) {
                out.append(c);
                continue;
            }
            int j = i + 1;
            int num = 0;
            boolean hasNum = false;
            while (j < pattern.length() && Character.isDigit(pattern.charAt(j))) {
                num = num * 10 + (pattern.charAt(j) - '0');
                hasNum = true;
                j++;
            }
            if (hasNum && j < pattern.length() && pattern.charAt(j) == '$') j++;
            if (j < pattern.length() && pattern.charAt(j) == 's') {
                int idx = hasNum ? num - 1 : auto++;
                out.append(idx >= 0 && idx < args.length ? String.valueOf(args[idx]) : "");
                i = j;
                continue;
            }
            if (j < pattern.length() && pattern.charAt(j) == '%') {
                out.append('%');
                i = j;
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }
}