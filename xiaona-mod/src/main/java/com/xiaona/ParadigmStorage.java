package com.xiaona;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

/**
 * 解析 Paradigm 的 {@code config/paradigm/storage.json}。
 *
 * <p>只做**只读**用途：确定它用的是哪种存储、sqlite 库文件在哪。
 * 不写它的库，也不依赖它的内部类——Paradigm 没装时这些代码完全不会被调用。
 */
final class ParadigmStorage {
    private static final String DEFAULT_PROVIDER = "sqlite";
    private static final String DEFAULT_DB = "data/paradigm.db";

    private ParadigmStorage() {}

    /** 存储后端：sqlite / json / mysql …；文件不存在或写得不规范时按 Paradigm 默认的 sqlite 处理 */
    static String provider(Path configDir) {
        JsonObject o = read(configDir);
        String p = o == null ? "" : findProvider(o);
        return p.isBlank() ? DEFAULT_PROVIDER : p;
    }

    /**
     * sqlite 库文件路径。
     * 后端不是 sqlite 时明确报错，**不能**悄悄回退原版名单——
     * 否则用户会看到"没有封禁"，以为兼容坏了。
     */
    static Path dbPath(Path configDir, String provider) {
        if (provider != null && !provider.isBlank() && !"sqlite".equals(provider)) {
            throw new BanException("Paradigm 存储后端为 " + provider
                    + "，当前只支持 sqlite；请把 config/paradigm/storage.json 的 provider 改为 sqlite，或等待后续版本支持");
        }
        JsonObject o = read(configDir);
        String raw = o == null ? "" : findDbPath(o);
        if (raw == null || raw.isBlank()) raw = DEFAULT_DB;
        return resolve(configDir, raw);
    }

    /** 相对路径按 config/paradigm/ 解析；写成 config/... 的按游戏根目录解析 */
    static Path resolve(Path configDir, String raw) {
        String v = raw.trim().replace('\\', '/');
        Path p = Path.of(v);
        if (p.isAbsolute()) return p.normalize();
        Path base = configDir;
        if (v.startsWith("config/")) {
            Path gameDir = configDir.getParent();
            if (gameDir != null) base = gameDir;
            return base.resolve(v).normalize();
        }
        return base.resolve("paradigm").resolve(v).normalize();
    }

    private static JsonObject read(Path configDir) {
        try {
            Path f = configDir.resolve("paradigm").resolve("storage.json");
            if (!Files.isRegularFile(f)) return null;
            String s = Files.readString(f, StandardCharsets.UTF_8);
            JsonElement el = JsonParser.parseString(s);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            BotState.error("[封禁] 读取 Paradigm storage.json 失败：" + e.getMessage() + "，按默认 sqlite 处理");
            return null;
        }
    }

    private static String findProvider(JsonElement el) {
        if (el == null || el.isJsonNull()) return "";
        if (el.isJsonObject()) {
            JsonObject o = el.getAsJsonObject();
            for (String key : new String[]{"provider", "type", "storage", "backend", "driver"}) {
                String v = stringOf(getIgnoreCase(o, key));
                if (!v.isBlank()) return normalizeProvider(v);
            }
            for (Map.Entry<String, JsonElement> e : o.entrySet()) {
                String v = findProvider(e.getValue());
                if (!v.isBlank()) return v;
            }
        } else if (el.isJsonArray()) {
            JsonArray a = el.getAsJsonArray();
            for (JsonElement e : a) {
                String v = findProvider(e);
                if (!v.isBlank()) return v;
            }
        }
        return "";
    }

    private static String normalizeProvider(String raw) {
        String v = raw.trim().toLowerCase(Locale.ROOT);
        if (v.equals("sqlite") || v.equals("sqlite3")) return "sqlite";
        if (v.equals("json") || v.equals("file") || v.equals("jsonfile") || v.equals("flatfile")) return "json";
        if (v.equals("mysql") || v.equals("mariadb") || v.equals("sql")) return "mysql";
        return v;
    }

    /** 在所有字符串里找 .db/.sqlite；优先 sqlite 段里的 path/file/database */
    private static String findDbPath(JsonElement el) {
        if (el == null || el.isJsonNull()) return "";
        if (el.isJsonObject()) {
            JsonObject o = el.getAsJsonObject();
            JsonElement sqlite = getIgnoreCase(o, "sqlite");
            String v = findPathIn(sqlite);
            if (!v.isBlank()) return v;
            for (String key : new String[]{"path", "file", "database", "dbfile", "filename", "db"}) {
                String s = stringOf(getIgnoreCase(o, key));
                if (isDbPath(s)) return s;
            }
            for (Map.Entry<String, JsonElement> e : o.entrySet()) {
                String s = findDbPath(e.getValue());
                if (!s.isBlank()) return s;
            }
        } else if (el.isJsonArray()) {
            for (JsonElement e : el.getAsJsonArray()) {
                String s = findDbPath(e);
                if (!s.isBlank()) return s;
            }
        } else {
            String s = stringOf(el);
            if (isDbPath(s)) return s;
        }
        return "";
    }

    private static String findPathIn(JsonElement el) {
        if (el == null || el.isJsonNull()) return "";
        if (el.isJsonObject()) {
            JsonObject o = el.getAsJsonObject();
            for (String key : new String[]{"path", "file", "database", "dbfile", "filename", "db"}) {
                String s = stringOf(getIgnoreCase(o, key));
                if (isDbPath(s)) return s;
            }
            for (Map.Entry<String, JsonElement> e : o.entrySet()) {
                String s = findPathIn(e.getValue());
                if (!s.isBlank()) return s;
            }
        } else if (el.isJsonArray()) {
            for (JsonElement e : el.getAsJsonArray()) {
                String s = findPathIn(e);
                if (!s.isBlank()) return s;
            }
        }
        return "";
    }

    private static boolean isDbPath(String s) {
        String v = s.trim().toLowerCase(Locale.ROOT);
        return v.endsWith(".db") || v.endsWith(".sqlite") || v.endsWith(".sqlite3");
    }

    private static JsonElement getIgnoreCase(JsonObject o, String key) {
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            if (e.getKey().equalsIgnoreCase(key)) return e.getValue();
        }
        return null;
    }

    private static String stringOf(JsonElement el) {
        try {
            return el != null && el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()
                    ? el.getAsString().trim() : "";
        } catch (Exception e) {
            return "";
        }
    }
}
