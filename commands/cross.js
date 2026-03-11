"use strict";

const { EmbedBuilder, Colors } = require("discord.js");
const { getAllGuildConfigs } = require("../utils/config");
const {
  sendReply,
  editReply,
  buildEmbed,
  buildServerList,
  parseDuration,
} = require("../utils/helpers");
const { findOrCreateThread } = require("../utils/threads");

const CROSSMUTE_FORM =
  process.env.CROSSMUTE_FORM_URL ||
  "https://docs.google.com/forms/d/e/1FAIpQLSemzPCO26jA4htNouc1Bafi3QULAIHcYYFRL5tEM9_xGW9ZNg/viewform";
const CROSSBAN_FORM =
  process.env.CROSSBAN_FORM_URL ||
  "https://docs.google.com/forms/d/e/1FAIpQLSfmAwCBcT2jBCvDe4pVlUmWbCxfRaJwjTNHZwCwjgrIKyXleQ/viewform";

// ─── SHARED LOGGING ───────────────────────────────────────────────────────────

async function logCrossAction(
  client,
  {
    configs,
    user,
    results,
    type,
    emoji,
    color,
    reason,
    duration,
    staffName,
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix,
  },
) {
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${filePrefix}_servers_${user.username}_${date}.txt`;
  const successCount = results.filter((r) => r.status.startsWith("✅")).length;

  for (const c of configs) {
    if (!c.channelId) continue;
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) continue;

    const reportsChannel = await guild.channels
      .fetch(c.channelId)
      .catch(() => null);
    if (!reportsChannel) continue;

    const thread = await findOrCreateThread(reportsChannel, user).catch(
      () => null,
    );
    if (!thread) continue;

    const embed = buildEmbed({
      type,
      emoji,
      color,
      reason,
      duration,
      staffName,
      staffId,
      imageUrl,
      sourceGuild,
      extraField: {
        name: "Servers Affected",
        value: `${successCount}/${configs.length}`,
      },
    });

    await thread
      .send({
        embeds: [embed],
        files: [
          {
            name: fileName,
            attachment: Buffer.from(buildServerList(results, type)),
          },
        ],
      })
      .catch(console.error);
  }
}

// ─── EXECUTORS ────────────────────────────────────────────────────────────────

async function executeCrossMute(
  client,
  crossActionInProgress,
  {
    userId,
    durationStr,
    reason,
    staffName,
    staffId,
    imageUrl = null,
    sourceGuild,
    replyTarget,
  },
) {
  const ms = parseDuration(durationStr);
  if (!ms)
    return (
      replyTarget &&
      sendReply(
        replyTarget,
        "❌ Invalid duration. Use formats like `10m`, `1h`, `7d`.",
      )
    );

  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return (
      replyTarget &&
      sendReply(replyTarget, `❌ Could not find user with ID \`${userId}\`.`)
    );

  const progressMsg = replyTarget
    ? await sendReply(
        replyTarget,
        `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
      )
    : null;

  crossActionInProgress.add(userId);
  setTimeout(() => crossActionInProgress.delete(userId), 30_000);

  const results = [];
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      results.push({
        name: c.guildId,
        id: c.guildId,
        status: "⚠️ Bot not in guild",
      });
      continue;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: "➖ Not a member",
      });
      continue;
    }
    try {
      await member.timeout(ms, reason);
      results.push({ name: guild.name, id: guild.id, status: "✅ Muted" });
    } catch (err) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: `❌ Failed: ${err.message}`,
      });
    }
  }

  await logCrossAction(client, {
    configs,
    user,
    results,
    type: "Cross-Mute",
    emoji: "🔇🌐",
    color: Colors.Orange,
    reason,
    duration: durationStr,
    staffName,
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix: "crossmute",
  });

  await user
    .send(
      `🔇 You have been **cross-muted** across multiple servers.\n**Reason:** ${reason}\n**Duration:** ${durationStr}\n\nIf you believe this was a mistake, you can appeal here:\n${CROSSMUTE_FORM}`,
    )
    .catch(() => console.log(`[dm] Could not DM ${user.username}`));

  const successCount = results.filter((r) => r.status === "✅ Muted").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `🔇 Cross-mute complete. Muted **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossUnmute(
  client,
  crossActionInProgress,
  { userId, reason, staffName, staffId, sourceGuild, replyTarget },
) {
  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return (
      replyTarget &&
      sendReply(replyTarget, `❌ Could not find user with ID \`${userId}\`.`)
    );

  const progressMsg = replyTarget
    ? await sendReply(
        replyTarget,
        `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
      )
    : null;

  crossActionInProgress.add(userId);
  setTimeout(() => crossActionInProgress.delete(userId), 30_000);

  const results = [];
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      results.push({
        name: c.guildId,
        id: c.guildId,
        status: "⚠️ Bot not in guild",
      });
      continue;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: "➖ Not a member",
      });
      continue;
    }
    try {
      await member.timeout(null, reason);
      results.push({ name: guild.name, id: guild.id, status: "✅ Unmuted" });
    } catch (err) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: `❌ Failed: ${err.message}`,
      });
    }
  }

  await logCrossAction(client, {
    configs,
    user,
    results,
    type: "Cross-Unmute",
    emoji: "🔊🌐",
    color: Colors.Blue,
    reason,
    duration: "N/A",
    staffName,
    staffId,
    imageUrl: null,
    sourceGuild,
    filePrefix: "crossunmute",
  });

  const successCount = results.filter((r) => r.status === "✅ Unmuted").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `🔊 Cross-unmute complete. Unmuted **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossBan(
  client,
  crossActionInProgress,
  {
    userId,
    reason,
    staffName,
    staffId,
    imageUrl = null,
    sourceGuild,
    replyTarget,
  },
) {
  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return (
      replyTarget &&
      sendReply(replyTarget, `❌ Could not find user with ID \`${userId}\`.`)
    );

  const progressMsg = replyTarget
    ? await sendReply(
        replyTarget,
        `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
      )
    : null;

  crossActionInProgress.add(userId);
  setTimeout(() => crossActionInProgress.delete(userId), 30_000);

  const results = [];
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      results.push({
        name: c.guildId,
        id: c.guildId,
        status: "⚠️ Bot not in guild",
      });
      continue;
    }
    try {
      await guild.members.ban(userId, { reason });
      results.push({ name: guild.name, id: guild.id, status: "✅ Banned" });
    } catch (err) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: `❌ Failed: ${err.message}`,
      });
    }
  }

  await logCrossAction(client, {
    configs,
    user,
    results,
    type: "Cross-Ban",
    emoji: "🔨🌐",
    color: Colors.Red,
    reason,
    duration: "Permanent",
    staffName,
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix: "crossban",
  });

  await user
    .send(
      `🔨 You have been **cross-banned** from multiple servers.\n**Reason:** ${reason}\n\nIf you believe this was a mistake, you can appeal here:\n${CROSSBAN_FORM}`,
    )
    .catch(() => console.log(`[dm] Could not DM ${user.username}`));

  const successCount = results.filter((r) => r.status === "✅ Banned").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `🔨 Cross-ban complete. Banned **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossUnban(
  client,
  crossActionInProgress,
  { userId, reason, staffName, staffId, sourceGuild, replyTarget },
) {
  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return (
      replyTarget &&
      sendReply(replyTarget, `❌ Could not find user with ID \`${userId}\`.`)
    );

  const progressMsg = replyTarget
    ? await sendReply(
        replyTarget,
        `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
      )
    : null;

  crossActionInProgress.add(userId);
  setTimeout(() => crossActionInProgress.delete(userId), 30_000);

  const results = [];
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      results.push({
        name: c.guildId,
        id: c.guildId,
        status: "⚠️ Bot not in guild",
      });
      continue;
    }
    try {
      await guild.members.unban(userId, reason);
      results.push({ name: guild.name, id: guild.id, status: "✅ Unbanned" });
    } catch (err) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: `❌ Failed: ${err.message}`,
      });
    }
  }

  await logCrossAction(client, {
    configs,
    user,
    results,
    type: "Cross-Unban",
    emoji: "✅🌐",
    color: Colors.Green,
    reason,
    duration: "N/A",
    staffName,
    staffId,
    imageUrl: null,
    sourceGuild,
    filePrefix: "crossunban",
  });

  const successCount = results.filter((r) => r.status === "✅ Unbanned").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `✅ Cross-unban complete. Unbanned **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossKick(
  client,
  crossActionInProgress,
  {
    userId,
    reason,
    staffName,
    staffId,
    imageUrl = null,
    sourceGuild,
    replyTarget,
  },
) {
  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return (
      replyTarget &&
      sendReply(replyTarget, `❌ Could not find user with ID \`${userId}\`.`)
    );

  const progressMsg = replyTarget
    ? await sendReply(
        replyTarget,
        `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
      )
    : null;

  crossActionInProgress.add(userId);
  setTimeout(() => crossActionInProgress.delete(userId), 30_000);

  const results = [];
  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      results.push({
        name: c.guildId,
        id: c.guildId,
        status: "⚠️ Bot not in guild",
      });
      continue;
    }
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: "➖ Not a member",
      });
      continue;
    }
    try {
      await member.kick(reason);
      results.push({ name: guild.name, id: guild.id, status: "✅ Kicked" });
    } catch (err) {
      results.push({
        name: guild.name,
        id: guild.id,
        status: `❌ Failed: ${err.message}`,
      });
    }
  }

  await logCrossAction(client, {
    configs,
    user,
    results,
    type: "Cross-Kick",
    emoji: "👢🌐",
    color: 0xff8c00,
    reason,
    duration: "N/A",
    staffName,
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix: "crosskick",
  });

  const successCount = results.filter((r) => r.status === "✅ Kicked").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `👢 Cross-kick complete. Kicked **${user.username}** from **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossCheck(
  client,
  { userId, staffId, sourceGuild, replyTarget },
) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );

  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const progressMsg = await sendReply(
    replyTarget,
    `🔍 Checking **${user.username}** across ${configs.length} server(s)...`,
  );

  const accountAge = Math.floor(
    (Date.now() - user.createdTimestamp) / 86400000,
  );
  const lines = [];

  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      lines.push(`⚠️ **${c.guildId}** — bot not in guild`);
      continue;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      const ban = await guild.bans.fetch(userId).catch(() => null);
      lines.push(
        ban
          ? `🔨 **${guild.name}** — Banned (reason: ${ban.reason ?? "none"})`
          : `➖ **${guild.name}** — Not a member`,
      );
      continue;
    }

    const joinedAgo = Math.floor(
      (Date.now() - member.joinedTimestamp) / 86400000,
    );
    const topRole = member.roles.highest?.name ?? "none";
    const isMuted =
      member.communicationDisabledUntilTimestamp &&
      member.communicationDisabledUntilTimestamp > Date.now();
    const muteStr = isMuted
      ? ` | 🔇 Muted until <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:R>`
      : "";
    lines.push(
      `✅ **${guild.name}** — Joined ${joinedAgo}d ago | Top role: ${topRole}${muteStr}`,
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Cross-Check: ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(Colors.Blurple)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "User ID", value: user.id, inline: true },
      { name: "Account Age", value: `${accountAge} days`, inline: true },
      {
        name: "Account Created",
        value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`,
        inline: true,
      },
    )
    .setTimestamp();

  if (sourceGuild)
    embed.addFields({
      name: "Requested from",
      value: `${sourceGuild.name} (\`${sourceGuild.id}\`)`,
      inline: false,
    });
  if (staffId)
    embed.addFields({
      name: "Requested by",
      value: `<@${staffId}>`,
      inline: true,
    });

  await editReply(replyTarget, progressMsg, { content: "", embeds: [embed] });
}

module.exports = {
  executeCrossMute,
  executeCrossUnmute,
  executeCrossBan,
  executeCrossUnban,
  executeCrossKick,
  executeCrossCheck,
};
