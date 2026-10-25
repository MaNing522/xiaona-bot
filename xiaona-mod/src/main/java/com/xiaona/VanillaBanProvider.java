package com.xiaona;

import net.minecraft.server.BannedPlayerEntry;
import net.minecraft.server.BannedPlayerList;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerConfigEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;

import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * 原版封禁名单（{@code UserBanList}）。
 *
 * <p>直接写名单、不走 /ban：1.21.11 的 /ban 走 GameProfileResolver 异步解析档案，
 * 离线/解析不到时会静默什么都不做也不报错，表现为「命令返回成功但 banlist 仍是空的」。
 */
final class VanillaBanProvider implements BanProvider {
    private final MinecraftServer server;

    VanillaBanProvider(MinecraftServer server) {
        this.server = server;
    }

    @Override
    public String id() {
        return "vanilla";
    }

    @Override
    public List<BanRow> list() {
        List<BanRow> list = new ArrayList<>();
        // 封禁名单是普通集合，必须在服务端线程里读，避免与 /ban 并发修改撞车
        CompletableFuture<Void> done = new CompletableFuture<>();
        server.execute(() -> {
            try {
                for (BannedPlayerEntry e : server.getPlayerManager().getUserBanList().values()) {
                    list.add(new BanRow(
                            e.getKey().name(),
                            String.valueOf(e.getKey().id()),
                            e.getReason() == null ? "" : e.getReason(),
                            e.getSource() == null ? "" : e.getSource(),
                            e.getCreationDate() == null ? 0 : e.getCreationDate().getTime(),
                            e.getExpiryDate() == null ? 0 : e.getExpiryDate().getTime()));
                }
            } catch (Throwable t) {
                BotState.error("[桥] 读取封禁名单失败：" + t.getMessage());
            } finally {
                done.complete(null);
            }
        });
        try { done.get(3, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已读到的返回 */ }
        return list;
    }

    @Override
    public Result ban(List<String> names, String reason) {
        List<String> done = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        Map<String, String> errors = new LinkedHashMap<>();
        CompletableFuture<Void> finished = new CompletableFuture<>();
        // 封禁名单是普通集合，增删必须在服务端线程里做
        server.execute(() -> {
            try {
                BannedPlayerList list = server.getPlayerManager().getUserBanList();
                for (String name : names) {
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) {
                        failed.add(name);
                        errors.put(name, "玩家名不合法（只能是 3~16 位字母、数字、下划线）");
                        continue;
                    }
                    try {
                        // 优先用服务器名称缓存里的真实档案（在线模式 UUID 才对得上），查不到再按离线档案
                        PlayerConfigEntry key = server.getApiServices().nameToIdCache().findByName(name)
                                .orElseGet(() -> PlayerConfigEntry.fromNickname(name));
                        if (!list.contains(key)) {
                            list.add(new BannedPlayerEntry(key, new Date(), "xiaona-bridge", null,
                                    reason.isBlank() ? "Banned by xiaona bridge" : reason));
                        }
                        ServerPlayerEntity online = server.getPlayerManager().getPlayer(name);
                        if (online != null) {
                            online.networkHandler.disconnect(Text.translatable("multiplayer.disconnect.banned"));
                        }
                        done.add(name);
                    } catch (Throwable t) {
                        BotState.error("[桥] 封禁 " + name + " 失败：" + t.getMessage());
                        failed.add(name);
                        errors.put(name, t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
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
                BannedPlayerList list = server.getPlayerManager().getUserBanList();
                for (String name : names) {
                    try {
                        boolean hit = false;
                        // 复制一份再遍历，边遍历边删会撞并发修改
                        for (BannedPlayerEntry e : new ArrayList<>(list.values())) {
                            if (e.getKey().name().equalsIgnoreCase(name)) {
                                list.remove(e);
                                hit = true;
                            }
                        }
                        if (hit) done.add(name); else failed.add(name);
                    } catch (Throwable t) {
                        BotState.error("[桥] 解封 " + name + " 失败：" + t.getMessage());
                        failed.add(name);
                        errors.put(name, t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
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
