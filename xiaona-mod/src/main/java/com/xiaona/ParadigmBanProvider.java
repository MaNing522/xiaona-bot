package com.xiaona;

import net.minecraft.server.MinecraftServer;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Paradigm 的封禁：读它自己的 SQLite 视图，写它注册的 /ban、/unban 命令。
 *
 * <p>Paradigm 的名单与原版完全分离，而且公开 API 没有 moderation 接口，
 * 所以**不能**直接改原版 UserBanList，也**不能**直接写它的库——前者 Paradigm 不认，
 * 后者会绕过它的内部约束。
 */
final class ParadigmBanProvider implements BanProvider {
    private final MinecraftServer server;
    private final Path configDir;

    ParadigmBanProvider(MinecraftServer server, Path configDir) {
        this.server = server;
        this.configDir = configDir;
    }

    @Override
    public String id() {
        return "paradigm";
    }

    @Override
    public List<BanRow> list() {
        String provider = ParadigmStorage.provider(configDir);
        Path db = ParadigmStorage.dbPath(configDir, provider);
        return ParadigmDb.readActive(db);
    }

    @Override
    public Result ban(List<String> names, String reason) {
        List<String> done = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        Map<String, String> errors = new LinkedHashMap<>();
        CompletableFuture<Void> finished = new CompletableFuture<>();
        server.execute(() -> {
            try {
                for (String name : names) {
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) {
                        failed.add(name);
                        errors.put(name, "玩家名不合法（只能是 3~16 位字母、数字、下划线）");
                        continue;
                    }
                    try {
                        BanCommandRunner.run(server, BanCommandRunner.banCommand(name, reason));
                        done.add(name);
                    } catch (BanException first) {
                        // 有的 Paradigm 版本 /ban 只收玩家名、不收原因；去掉原因再试一次
                        try {
                            BanCommandRunner.run(server, BanCommandRunner.banCommand(name, ""));
                            done.add(name);
                        } catch (BanException second) {
                            failed.add(name);
                            errors.put(name, second.getMessage());
                            BotState.error("[封禁] Paradigm 封禁 " + name + " 失败：" + second.getMessage());
                        }
                    }
                }
            } finally {
                finished.complete(null);
            }
        });
        try { finished.get(5, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已处理的结果返回 */ }
        return new Result(done, failed, errors);
    }

    @Override
    public Result unban(List<String> names) {
        List<String> done = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        Map<String, String> errors = new LinkedHashMap<>();
        CompletableFuture<Void> finished = new CompletableFuture<>();
        server.execute(() -> {
            try {
                for (String name : names) {
                    try {
                        BanCommandRunner.run(server, BanCommandRunner.unbanCommand(name));
                        done.add(name);
                    } catch (BanException first) {
                        // 部分版本没有 /unban，用原版 /pardon 兜底
                        try {
                            BanCommandRunner.run(server, BanCommandRunner.pardonCommand(name));
                            done.add(name);
                        } catch (BanException second) {
                            failed.add(name);
                            errors.put(name, second.getMessage());
                            BotState.error("[封禁] Paradigm 解封 " + name + " 失败：" + second.getMessage());
                        }
                    }
                }
            } finally {
                finished.complete(null);
            }
        });
        try { finished.get(5, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已处理的结果返回 */ }
        return new Result(done, failed, errors);
    }
}
