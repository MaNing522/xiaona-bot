package com.xiaona.mixin;

import com.mojang.brigadier.StringReader;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 命令参数里的中文名修复。
 *
 * <p>Brigadier 的「不带引号的字符串」默认只认 ASCII 的字母/数字和 {@code _ - . +}，
 * 所以中文游戏ID在命令里会卡在解析阶段：
 * <ul>
 *   <li>{@code /tp 小明 Steve}、{@code /gamemode creative 小明}</li>
 *   <li>实体选择器 {@code @a[name=小明]}、{@code @p[team=红队]}</li>
 *   <li>carpet 的 {@code /player 小明 spawn}（参数就是 {@code StringArgumentType.word()}）</li>
 * </ul>
 * 都会报 {@code Expected word} / 找不到玩家。
 *
 * <p>这里只放宽 {@code isAllowedInUnquotedString}：把 Unicode 字母/数字也视为可出现在无引号字符串里。
 * 空格、括号、等号、引号等分隔符保持原样，所以命令语法不会被拆坏；记分板名、队伍名、
 * 假人名等「按字符串收参」的地方也随之支持中文。
 */
@Mixin(StringReader.class)
public class StringReaderMixin {
    @Inject(method = "isAllowedInUnquotedString", at = @At("HEAD"), cancellable = true)
    private static void xiaona$allowUnicode(char c, CallbackInfoReturnable<Boolean> cir) {
        try {
            if (Character.isLetterOrDigit(c)) cir.setReturnValue(true);
        } catch (Throwable ignored) {
        }
    }
}
