"use strict";

const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { fetchLatestChapter } = require("./manga");
const { executePurgeAll } = require("../commands/purge");
const { EmbedBuilder, Colors, PermissionsBitField } = require("discord.js");

// ─── ERROR REPORTING ──────────────────────────────────────────────────────────

async function postError(client, guildConfig, message) {
  const { guildId, errorsChannelId } = guildConfig;
  if (!errorsChannelId) return;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = await guild.channels
      .fetch(errorsChannelId)
      .catch(() => null);
    if (!channel) return;
    await channel.send(
      `<@450842915024142374> ⚠️ **Manga scheduler error** — ${message}`,
    );
  } catch (err) {
    console.error(
      `[manga] Failed to post error to errors channel: ${err.message}`,
    );
  }
}

// ─── CHANNEL LOCK / UNLOCK ────────────────────────────────────────────────────

async function setRawsChannelOpen(channel, allow, client, guildConfig) {
  const { rawsIgnoredRoles = [] } = guildConfig;

  try {
    const guild = channel.guild;
    await guild.members.fetch();

    // Build updated overwrites array — one channel.edit() = one API call
    const newOverwrites = channel.permissionOverwrites.cache.map((ow) => {
      const isIgnored =
        (ow.type === 0 && rawsIgnoredRoles.includes(ow.id)) ||
        (ow.type === 1 &&
          (() => {
            const m = guild.members.cache.get(ow.id);
            return m && rawsIgnoredRoles.some((r) => m.roles.cache.has(r));
          })());

      if (isIgnored) return ow; // pass through unchanged

      // Reconstruct with SendMessages flipped
      const allowBits = allow
        ? ow.allow.add("SendMessages")
        : ow.allow.remove("SendMessages");
      const denyBits = allow
        ? ow.deny.remove("SendMessages")
        : ow.deny.add("SendMessages");

      return { id: ow.id, type: ow.type, allow: allowBits, deny: denyBits };
    });

    // Handle @everyone — add or update
    const everyoneId = guild.roles.everyone.id;
    if (!rawsIgnoredRoles.includes(everyoneId)) {
      const everyoneIdx = newOverwrites.findIndex(
        (o) => (o.id?.id ?? o.id) === everyoneId,
      );
      const base = channel.permissionOverwrites.cache.get(everyoneId);
      const allowBits = allow
        ? (base?.allow ?? new PermissionsBitField()).add("SendMessages")
        : (base?.allow ?? new PermissionsBitField()).remove("SendMessages");
      const denyBits = allow
        ? (base?.deny ?? new PermissionsBitField()).remove("SendMessages")
        : (base?.deny ?? new PermissionsBitField()).add("SendMessages");
      const entry = {
        id: everyoneId,
        type: 0,
        allow: allowBits,
        deny: denyBits,
      };

      if (everyoneIdx >= 0) newOverwrites[everyoneIdx] = entry;
      else newOverwrites.push(entry);
    }

    const botId = client.user.id;
    const botIdx = newOverwrites.findIndex((o) => (o.id?.id ?? o.id) === botId);
    const base = channel.permissionOverwrites.cache.get(botId);
    const allowBits = (base?.allow ?? new PermissionsBitField()).add(
      "SendMessages",
    );
    const denyBits = (base?.deny ?? new PermissionsBitField()).remove(
      "SendMessages",
    );
    const entry = { id: botId, type: 1, allow: allowBits, deny: denyBits };
    if (botIdx >= 0) newOverwrites[botIdx] = entry;
    else newOverwrites.push(entry);

    await channel.edit({ permissionOverwrites: newOverwrites });

    console.log(
      `[manga] ${allow ? "🔓 Unlocked" : "🔒 Locked"} #${channel.name} ` +
        `(${channel.id}) in guild ${guild.id}`,
    );

    const embed = new EmbedBuilder()
      .setColor(allow ? Colors.Green : Colors.Red)
      .setTitle(allow ? "🔓 Channel unlocked" : "🔒 Channel locked")
      .setDescription(
        allow
          ? `<#${channel.id}> has been unlocked.`
          : `<#${channel.id}> has been locked.`,
      )
      .addFields({
        name: "Moderator",
        value: `<@${client.user.id}>`,
        inline: true,
      })
      .setTimestamp();

    // For lock: embed is sent AFTER purge (caller handles it).
    // For unlock: send immediately.
    if (allow) {
      await channel
        .send({ embeds: [embed] })
        .catch((err) =>
          console.error(`[manga] Failed to send unlock embed: ${err.message}`),
        );
    } else {
      channel._pendingLockEmbed = embed; // stash for after purge
    }

    return true;
  } catch (err) {
    console.error(
      `[manga] Failed to ${allow ? "unlock" : "lock"} #${channel.name} (${channel.id}): ${err.message}`,
    );
    await postError(
      client,
      guildConfig,
      `Failed to ${allow ? "unlock" : "lock"} <#${channel.id}>: ${err.message}`,
    );
    return false;
  }
}

/**
 * Fetches the raws channel for a guild config.
 * Returns null (with a warning) if not configured or not found.
 */
async function getRawsChannel(client, guildConfig) {
  const { guildId, rawsChannel } = guildConfig;
  if (!rawsChannel) return null;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(`[manga] Guild ${guildId} not in cache`);
    return null;
  }

  const channel = await guild.channels.fetch(rawsChannel).catch(() => null);
  if (!channel) {
    console.warn(
      `[manga] Raws channel ${rawsChannel} not found in guild ${guildId}`,
    );
    return null;
  }

  return channel;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseMangaReleaseTime(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length < 2)
    throw new Error(`Expected "Day HH:MM [Timezone]", got: "${str}"`);

  const [dayStr, timeStr, ...tzParts] = parts;
  const dayNum = DAY_MAP[dayStr.toLowerCase()];
  if (dayNum === undefined) throw new Error(`Unknown day: "${dayStr}"`);

  const [hourStr, minuteStr = "0", secondStr = "0"] = timeStr.split(":");
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = parseInt(secondStr, 10);

  if (isNaN(hour) || isNaN(minute) || isNaN(second)) {
    throw new Error(`Invalid time: "${timeStr}"`);
  }

  const timezone = tzParts.join(" ") || "UTC";
  const cronExpr = `${second} ${minute} ${hour} * * ${dayNum}`;
  return { cronExpr, timezone };
}

function loadTemplate(messagesDir, guildId, mangaName) {
  const filePath = path.join(messagesDir, `${guildId}_${mangaName}.txt`);
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8").trim();
  return (
    `{role} **{mangaName}** ({chapterName}) is out now on MangaPlus!\n` +
    `{chapterLink}`
  );
}

function applyTemplate(
  template,
  { role, mangaName, chapterName, chapterLink },
) {
  return template
    .replace(/\{role\}/g, role ?? "")
    .replace(/\{mangaName\}/g, mangaName ?? "")
    .replace(/\{chapterName\}/g, chapterName ?? "")
    .replace(/\{chapterLink\}/g, chapterLink ?? "");
}

// ─── CORE LOGIC ───────────────────────────────────────────────────────────────

async function checkAndPost(client, guildConfig, messagesDir) {
  const {
    guildId,
    mangaplusId,
    mangaUpdatesChannel,
    mangaUpdatesRole,
    mangaName,
  } = guildConfig;
  if (!mangaplusId || !mangaUpdatesChannel || !mangaName) return null;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(`[manga] Guild ${guildId} not in cache`);
    return null;
  }

  const channel = await guild.channels
    .fetch(mangaUpdatesChannel)
    .catch(() => null);
  if (!channel) {
    console.warn(
      `[manga] Channel ${mangaUpdatesChannel} not found in guild ${guildId}`,
    );
    return null;
  }

  // ── 1. Fetch latest chapter ──────────────────────────────────────────────
  let latest;
  try {
    latest = await fetchLatestChapter(mangaplusId);
    console.log(
      `[manga] Latest for ${mangaName} (guild ${guildId}): ` +
        `${latest.chapterName} → ${latest.chapterLink}`,
    );
  } catch (err) {
    const msg = `Failed to fetch latest chapter for **${mangaName}**: ${err.message}`;
    console.error(`[manga] ${msg} (guild ${guildId})`);
    await postError(client, guildConfig, msg);
    return null;
  }

  // ── 2. Break-week guard ──────────────────────────────────────────────────
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const alreadyPosted = recent.some(
      (m) =>
        m.author.id === client.user.id &&
        m.content.includes(latest.chapterLink),
    );
    if (alreadyPosted) {
      console.log(
        `[manga] ${mangaName} chapter ${latest.chapterId} already posted ` +
          `in guild ${guildId} — skipping (break week or duplicate run)`,
      );
      return null;
    }
  }

  // ── 3. Post manga update ─────────────────────────────────────────────────
  const template = loadTemplate(messagesDir, guildId, mangaName);
  const roleMention = mangaUpdatesRole ? `<@&${mangaUpdatesRole}>` : "";
  const message = applyTemplate(template, {
    role: roleMention,
    mangaName,
    chapterName: latest.chapterName,
    chapterLink: latest.chapterLink,
  });

  await channel
    .send(message)
    .catch((err) =>
      console.error(`[manga] Send failed in guild ${guildId}: ${err.message}`),
    );

  console.log(
    `[manga] ✅ Posted ${mangaName} "${latest.chapterName}" in guild ${guildId}`,
  );

  // ── 4. Lock + purge the raws channel ────────────────────────────────────
  if (guildConfig.rawsChannel) {
    const rawsCh = await getRawsChannel(client, guildConfig);
    if (rawsCh) {
      // Lock first (send s!lock via webhook). Only purge if lock succeeded.
      const locked = await setRawsChannelOpen(
        rawsCh,
        false,
        client,
        guildConfig,
      );
      if (!locked) {
        console.warn(
          `[manga] Skipping purge for guild ${guildId} because lock was not performed`,
        );
      } else {
        try {
          await executePurgeAll({
            channel: rawsCh,
            allowedChannels: guildConfig.purgeChannels,
            staffName: "Manga Scheduler",
            staffId: client.user.id,
            editProgressFn: (msg) => {
              console.log(`[manga/purge] ${msg.replace(/[*_`<>]/g, "")}`);
              return Promise.resolve();
            },
          });
          if (rawsCh._pendingLockEmbed) {
            await rawsCh
              .send({ embeds: [rawsCh._pendingLockEmbed] })
              .catch((err) =>
                console.error(
                  `[manga] Failed to send lock embed: ${err.message}`,
                ),
              );
            delete rawsCh._pendingLockEmbed;
          }
        } catch (err) {
          const msg = `Failed to purge raws channel: ${err.message}`;
          console.error(`[manga] ${msg} (guild ${guildId})`);
          await postError(client, guildConfig, msg);
        }
      }
    }
  }

  return latest;
}

// ─── SCHEDULER INIT ───────────────────────────────────────────────────────────

function initMangaSchedulers(client, configs, messagesDir) {
  if (!fs.existsSync(messagesDir)) {
    fs.mkdirSync(messagesDir, { recursive: true });
    console.log(`[manga] Created messages directory at ${messagesDir}`);
  }

  const scheduledConfigs = [];

  for (const config of configs) {
    if (!config.mangaplusId || !config.mangaReleaseTime) continue;

    // ── Manga release cron (post + lock + purge raws) ──────────────────────
    let cronExpr, timezone;
    try {
      ({ cronExpr, timezone } = parseMangaReleaseTime(config.mangaReleaseTime));
    } catch (err) {
      console.error(
        `[manga] Bad MANGA_RELEASE_TIME for guild ${config.guildId}: ${err.message}`,
      );
      continue;
    }

    if (!cron.validate(cronExpr)) {
      console.error(
        `[manga] Computed cron "${cronExpr}" is invalid for guild ${config.guildId}`,
      );
      continue;
    }

    cron.schedule(
      cronExpr,
      () => {
        checkAndPost(client, config, messagesDir).catch((err) => {
          const msg = `Unhandled error in scheduled check for **${config.mangaName}**: ${err.message}`;
          console.error(`[manga] ${msg} (guild ${config.guildId})`);
          postError(client, config, msg).catch(console.error);
        });
      },
      { scheduled: true, timezone },
    );

    console.log(
      `[manga] 📅 Scheduled ${config.mangaName} release for guild ${config.guildId}: ` +
        `${cronExpr} (${timezone})`,
    );

    // ── Raws open cron (send s!unlock) ────────────────────────────────────
    if (config.rawsChannel && config.rawsOpenTime) {
      let openCron, openTz;
      try {
        ({ cronExpr: openCron, timezone: openTz } = parseMangaReleaseTime(
          config.rawsOpenTime,
        ));
      } catch (err) {
        console.error(
          `[manga] Bad RAWS_OPEN_TIME for guild ${config.guildId}: ${err.message}`,
        );
        // Still push to scheduledConfigs so manualCheck works
        scheduledConfigs.push(config);
        continue;
      }

      if (!cron.validate(openCron)) {
        console.error(
          `[manga] Computed cron "${openCron}" is invalid for guild ${config.guildId}`,
        );
        scheduledConfigs.push(config);
        continue;
      }

      cron.schedule(
        openCron,
        () => {
          getRawsChannel(client, config)
            .then((ch) => ch && setRawsChannelOpen(ch, true, client, config))
            .catch((err) => {
              const msg = `Failed to unlock raws channel: ${err.message}`;
              console.error(`[manga] ${msg} (guild ${config.guildId})`);
              postError(client, config, msg).catch(console.error);
            });
        },
        { scheduled: true, timezone: openTz },
      );

      console.log(
        `[manga] 🔓 Scheduled raws unlock for guild ${config.guildId}: ` +
          `${openCron} (${openTz})`,
      );
    }

    scheduledConfigs.push(config);
  }

  return {
    manualCheck(guildId) {
      const config =
        scheduledConfigs.find((c) => c.guildId === guildId) ??
        configs.find((c) => c.guildId === guildId);
      if (!config?.mangaplusId) {
        return Promise.reject(
          new Error("No manga configuration found for this server"),
        );
      }
      return checkAndPost(client, config, messagesDir);
    },
  };
}

module.exports = { initMangaSchedulers };
