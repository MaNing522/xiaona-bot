package com.xiaona;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;

import java.nio.file.Path;

/**
 * 选择封禁来源：装了 Paradigm 就用它的名单，否则保持原版。
 *
 * <p>这里刻意不引用 Paradigm 的任何类——它没装时不能有 NoClassDefFoundError。
 * 唯一依赖是它的 mod id、storage.json 和命令。
 */
final class BanService {
    private BanService() {}

    static boolean paradigmLoaded() {
        try {
            return FabricLoader.getInstance().isModLoaded("paradigm");
        } catch (Throwable t) {
            // 单测环境没有 FabricLoader，按"没装"处理
            return false;
        }
    }

    /** 只给状态接口看，不做文件 IO */
    static String currentId() {
        return paradigmLoaded() ? "paradigm" : "vanilla";
    }

    static BanProvider provider(MinecraftServer server) {
        if (!paradigmLoaded()) return new VanillaBanProvider(server);
        try {
            Path configDir = FabricLoader.getInstance().getConfigDir();
            return new ParadigmBanProvider(server, configDir);
        } catch (Throwable t) {
            throw new BanException("检测到 Paradigm，但拿不到 config 目录：" + t.getMessage(), t);
        }
    }
}
