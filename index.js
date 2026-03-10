require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  Colors,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require("discord.js");
const { findOrCreateThread } = require("./utils/threads");
const { formatDuration } = require("./utils/format");
const express = require("express");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// GUILD_CONFIGS format:
// {
//   "guildId": {
//     "channelId": "reportsChannelId",
//     "appealsChannelId": "appealsChannelId",
//     "prefix": "!",
//     "adminRoles": ["roleId1", "roleId2"]
//   }
// }

function getGuildConfig(guildId) {
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    const entry = configs[guildId];
    if (!entry) return null;
    if (typeof entry === "string")
      return {
        channelId: entry,
        appealsChannelId: null,
        prefix: process.env.COMMAND_PREFIX || "!",
        adminRoles: [],
      };
    return {
      channelId: entry.channelId,
      appealsChannelId: entry.appealsChannelId ?? null,
      prefix: entry.prefix || "!",
      adminRoles: entry.adminRoles || [],
    };
  }
  return {
    channelId: process.env.REPORTS_CHANNEL_ID,
    appealsChannelId: process.env.APPEALS_CHANNEL_ID ?? null,
    prefix: process.env.COMMAND_PREFIX || "!",
    adminRoles: [],
  };
}

function getAllGuildConfigs() {
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    return Object.entries(configs).map(([guildId, entry]) => ({
      guildId,
      ...(typeof entry === "string"
        ? {
            channelId: entry,
            appealsChannelId: null,
            prefix: "!",
            adminRoles: [],
          }
        : {
            channelId: entry.channelId,
            appealsChannelId: entry.appealsChannelId ?? null,
            prefix: entry.prefix || "!",
            adminRoles: entry.adminRoles || [],
          }),
    }));
  }
  return [
    {
      guildId: null,
      channelId: process.env.REPORTS_CHANNEL_ID,
      appealsChannelId: process.env.APPEALS_CHANNEL_ID ?? null,
      prefix: process.env.COMMAND_PREFIX || "!",
      adminRoles: [],
    },
  ];
}

function getReportsChannelId(guildId) {
  return getGuildConfig(guildId)?.channelId ?? null;
}

function hasAdminRole(member, adminRoles) {
  if (!adminRoles || adminRoles.length === 0) return true;
  return member.roles.cache.some((r) => adminRoles.includes(r.id));
}

const CROSS_PREFIX = process.env.CROSS_PREFIX || "&";
const CROSSMUTE_FORM =
  process.env.CROSSMUTE_FORM_URL ||
  "https://docs.google.com/forms/d/e/1FAIpQLSemzPCO26jA4htNouc1Bafi3QULAIHcYYFRL5tEM9_xGW9ZNg/viewform";
const CROSSBAN_FORM =
  process.env.CROSSBAN_FORM_URL ||
  "https://docs.google.com/forms/d/e/1FAIpQLSfmAwCBcT2jBCvDe4pVlUmWbCxfRaJwjTNHZwCwjgrIKyXleQ/viewform";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme";

const pendingData = new Map();
const crossActionInProgress = new Set();

// ─── SLASH COMMAND DEFINITIONS ────────────────────────────────────────────────

const crossCommands = [
  new SlashCommandBuilder()
    .setName("crossmute")
    .setDescription("Mute a user in ALL servers the bot is in")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to mute").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("duration")
        .setDescription("Duration (e.g. 10m, 1h, 7d)")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false),
    )
    .addAttachmentOption((o) =>
      o.setName("image").setDescription("Optional image").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("crossunmute")
    .setDescription("Unmute a user in ALL servers the bot is in")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to unmute").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("crossban")
    .setDescription("Ban a user in ALL servers the bot is in")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to ban").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false),
    )
    .addAttachmentOption((o) =>
      o.setName("image").setDescription("Optional image").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("crossunban")
    .setDescription("Unban a user in ALL servers the bot is in")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to unban").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("crosskick")
    .setDescription("Kick a user from ALL servers the bot is in")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to kick").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason").setRequired(false),
    )
    .addAttachmentOption((o) =>
      o.setName("image").setDescription("Optional image").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("crosscheck")
    .setDescription("Check a user's presence and info across all servers")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) =>
      o.setName("userid").setDescription("User ID to check").setRequired(true),
    ),
].map((c) => c.toJSON());

// ─── READY ────────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`🔍  Watching ${client.guilds.cache.size} guild(s)`);

  const configs = getAllGuildConfigs();
  for (const c of configs) {
    console.log(
      `📋  Guild ${c.guildId} → reports: ${c.channelId} | appeals: ${c.appealsChannelId ?? "not set"} | prefix: ${c.prefix}`,
    );
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  for (const c of configs) {
    if (!c.guildId) continue;
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, c.guildId),
        { body: crossCommands },
      );
      console.log(`✅  Slash commands registered in guild ${c.guildId}`);
    } catch (err) {
      console.error(
        `❌  Failed to register slash commands in guild ${c.guildId}:`,
        err.message,
      );
    }
  }
});

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const config = getGuildConfig(message.guild.id);
  if (!config) return;

  const content = message.content;

  // ── Cross-commands ──
  if (content.startsWith(CROSS_PREFIX)) {
    const args = content.slice(CROSS_PREFIX.length).trim().split(/\s+/);
    const command = args[0]?.toLowerCase();
    const validCrossCommands = [
      "crossmute",
      "crossunmute",
      "crossban",
      "crossunban",
      "crosskick",
      "crosscheck",
    ];

    if (validCrossCommands.includes(command)) {
      if (!hasAdminRole(message.member, config.adminRoles)) {
        return message.reply(
          "❌ You don't have permission to use cross-commands.",
        );
      }

      const userId = args[1];
      if (!userId || !/^\d+$/.test(userId)) {
        return message.reply(
          `❌ Usage: \`${CROSS_PREFIX}${command} <userID>${command === "crossmute" ? " <duration>" : ""} [reason]\``,
        );
      }

      const attachment = message.attachments.first();
      const imageUrl = attachment?.url ?? null;

      if (command === "crossmute") {
        const durationStr = args[2];
        if (!durationStr)
          return message.reply(
            `❌ Usage: \`${CROSS_PREFIX}crossmute <userID> <duration> [reason]\``,
          );
        const reason = args.slice(3).join(" ") || "No reason provided";
        await executeCrossMute({
          userId,
          durationStr,
          reason,
          staffName: message.author.username,
          imageUrl,
          replyTarget: message,
        });
      } else if (command === "crossunmute") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossUnmute({
          userId,
          reason,
          staffName: message.author.username,
          replyTarget: message,
        });
      } else if (command === "crossban") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossBan({
          userId,
          reason,
          staffName: message.author.username,
          imageUrl,
          replyTarget: message,
        });
      } else if (command === "crossunban") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossUnban({
          userId,
          reason,
          staffName: message.author.username,
          replyTarget: message,
        });
      } else if (command === "crosskick") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossKick({
          userId,
          reason,
          staffName: message.author.username,
          imageUrl,
          replyTarget: message,
        });
      } else if (command === "crosscheck") {
        await executeCrossCheck({ userId, replyTarget: message });
      }
      return;
    }
  }

  // ── Regular mod commands ──
  const prefix = config.prefix;
  if (!content.startsWith(prefix)) return;

  const args = content.slice(prefix.length).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  const watchedCommands = [
    "mute",
    "timeout",
    "ban",
    "warn",
    "kick",
    "unmute",
    "untimeout",
    "unban",
  ];
  if (!watchedCommands.includes(command)) return;

  const userArg = args[1];
  if (!userArg) return;
  const userId = userArg.replace(/[<@!>]/g, "");
  if (!/^\d+$/.test(userId)) return;

  const attachment = message.attachments.first();
  const key = `${message.guild.id}:${userId}`;

  const hasDuration = ["mute", "timeout"].includes(command);
  const reasonArgs = hasDuration ? args.slice(3) : args.slice(2);
  const parsedReason = reasonArgs.join(" ") || null;

  console.log(
    `[msg] ✅ command="${command}" target=${userId} staff=${message.author.username} guild=${message.guild.id}`,
  );
  pendingData.set(key, {
    staffName: message.author.username,
    reason: parsedReason,
    url: attachment?.url ?? null,
    timestamp: Date.now(),
  });
  setTimeout(() => pendingData.delete(key), 15_000);

  if (command === "warn") {
    const reason = parsedReason || "No reason provided";
    try {
      const reportsChannelId = getReportsChannelId(message.guild.id);
      if (!reportsChannelId)
        return console.warn(
          `[warn] No reports channel configured for guild ${message.guild.id}`,
        );

      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return console.warn(`[warn] Could not fetch user ${userId}`);

      const reportsChannel =
        await message.guild.channels.fetch(reportsChannelId);
      if (!reportsChannel)
        return console.error("[warn] Reports channel not found!");

      const thread = await findOrCreateThread(reportsChannel, user);
      const embed = buildEmbed({
        type: "Warn",
        emoji: "⚠️",
        color: Colors.Yellow,
        reason,
        duration: "N/A",
        staffName: message.author.username,
        imageUrl: attachment?.url ?? null,
      });
      await thread.send({ embeds: [embed] });
      console.log(
        `[warn] Logged for ${user.username} (${userId}) in guild ${message.guild.id}`,
      );
    } catch (err) {
      console.error("[warn] Error:", err);
    }
  }
});

// ─── SLASH COMMAND HANDLER ────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  // ── Button handler ──
  if (interaction.isButton()) {
    await handleAppealButton(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const validCommands = [
    "crossmute",
    "crossunmute",
    "crossban",
    "crossunban",
    "crosskick",
    "crosscheck",
  ];
  if (!validCommands.includes(commandName)) return;

  const config = getGuildConfig(guild.id);
  if (!hasAdminRole(member, config?.adminRoles ?? [])) {
    return interaction.reply({
      content: "❌ You don't have permission to use cross-commands.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const userId = interaction.options.getString("userid");
  const reason =
    interaction.options.getString("reason") || "No reason provided";
  const staffName = member.user.username;
  const imageUrl = interaction.options.getAttachment?.("image")?.url ?? null;

  if (commandName === "crossmute") {
    const durationStr = interaction.options.getString("duration");
    await executeCrossMute({
      userId,
      durationStr,
      reason,
      staffName,
      imageUrl,
      replyTarget: interaction,
    });
  } else if (commandName === "crossunmute") {
    await executeCrossUnmute({
      userId,
      reason,
      staffName,
      replyTarget: interaction,
    });
  } else if (commandName === "crossban") {
    await executeCrossBan({
      userId,
      reason,
      staffName,
      imageUrl,
      replyTarget: interaction,
    });
  } else if (commandName === "crossunban") {
    await executeCrossUnban({
      userId,
      reason,
      staffName,
      replyTarget: interaction,
    });
  } else if (commandName === "crosskick") {
    await executeCrossKick({
      userId,
      reason,
      staffName,
      imageUrl,
      replyTarget: interaction,
    });
  } else if (commandName === "crosscheck") {
    await executeCrossCheck({ userId, replyTarget: interaction });
  }
});

// ─── APPEAL BUTTON HANDLER ────────────────────────────────────────────────────

async function handleAppealButton(interaction) {
  const { customId, guild, member } = interaction;

  // customId format: appeal_accept_mute_{userId} or appeal_reject_mute_{userId}
  if (!customId.startsWith("appeal_")) return;

  const parts = customId.split("_");
  // parts: ["appeal", "accept"|"reject", "mute"|"ban", userId]
  const action = parts[1]; // accept or reject
  const type = parts[2]; // mute or ban
  const userId = parts[3];

  const config = getGuildConfig(guild.id);

  // Check if staff member has permission
  if (!hasAdminRole(member, config?.adminRoles ?? [])) {
    return interaction.reply({
      content: "❌ You don't have permission to approve or reject appeals.",
      ephemeral: true,
    });
  }

  await interaction.deferUpdate();

  const originalEmbed = interaction.message.embeds[0];
  const staffName = member.user.username;

  if (action === "accept") {
    const user = await client.users.fetch(userId).catch(() => null);
    const username = user?.username ?? userId;

    // Execute the appropriate cross-action
    if (type === "mute") {
      await executeCrossUnmute({
        userId,
        reason: "Appeal accepted",
        staffName,
        replyTarget: null,
      });
    } else if (type === "ban") {
      await executeCrossUnban({
        userId,
        reason: "Appeal accepted",
        staffName,
        replyTarget: null,
      });
    }

    // Update embed to show accepted
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(Colors.Green)
      .addFields({ name: "✅ Approved by", value: staffName });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`appeal_accept_${type}_${userId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`appeal_reject_${type}_${userId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    );

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });
    console.log(
      `[appeal] Accepted ${type} appeal for ${username} by ${staffName}`,
    );
  } else if (action === "reject") {
    const user = await client.users.fetch(userId).catch(() => null);
    const username = user?.username ?? userId;

    // Update embed to show rejected
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(Colors.Red)
      .addFields({ name: "❌ Rejected by", value: staffName });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`appeal_accept_${type}_${userId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`appeal_reject_${type}_${userId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    );

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });
    console.log(
      `[appeal] Rejected ${type} appeal for ${username} by ${staffName}`,
    );
  }
}

// ─── CROSS-COMMAND EXECUTORS ──────────────────────────────────────────────────

async function executeCrossMute({
  userId,
  durationStr,
  reason,
  staffName,
  imageUrl = null,
  replyTarget,
}) {
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

  await logCrossAction({
    configs,
    user,
    results,
    type: "Cross-Mute",
    emoji: "🔇🌐",
    color: Colors.Orange,
    reason,
    duration: durationStr,
    staffName,
    imageUrl,
    filePrefix: "crossmute",
  });

  // DM the user with appeal form link
  await user
    .send(
      `🔇 You have been **cross-muted** across multiple servers.\n` +
        `**Reason:** ${reason}\n` +
        `**Duration:** ${durationStr}\n\n` +
        `If you believe this was a mistake, you can appeal here:\n${CROSSMUTE_FORM}`,
    )
    .catch(() =>
      console.log(`[dm] Could not DM ${user.username} — DMs likely closed`),
    );

  const successCount = results.filter((r) => r.status === "✅ Muted").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `🔇 Cross-mute complete. Muted **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossUnmute({ userId, reason, staffName, replyTarget }) {
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

  await logCrossAction({
    configs,
    user,
    results,
    type: "Cross-Unmute",
    emoji: "🔊🌐",
    color: Colors.Blue,
    reason,
    duration: "N/A",
    staffName,
    imageUrl: null,
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

async function executeCrossBan({
  userId,
  reason,
  staffName,
  imageUrl = null,
  replyTarget,
}) {
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

  await logCrossAction({
    configs,
    user,
    results,
    type: "Cross-Ban",
    emoji: "🔨🌐",
    color: Colors.Red,
    reason,
    duration: "Permanent",
    staffName,
    imageUrl,
    filePrefix: "crossban",
  });

  // DM the user with appeal form link
  await user
    .send(
      `🔨 You have been **cross-banned** from multiple servers.\n` +
        `**Reason:** ${reason}\n\n` +
        `If you believe this was a mistake, you can appeal here:\n${CROSSBAN_FORM}`,
    )
    .catch(() =>
      console.log(`[dm] Could not DM ${user.username} — DMs likely closed`),
    );

  const successCount = results.filter((r) => r.status === "✅ Banned").length;
  if (progressMsg)
    await editReply(
      replyTarget,
      progressMsg,
      `🔨 Cross-ban complete. Banned **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
    );
}

async function executeCrossUnban({ userId, reason, staffName, replyTarget }) {
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

  await logCrossAction({
    configs,
    user,
    results,
    type: "Cross-Unban",
    emoji: "✅🌐",
    color: Colors.Green,
    reason,
    duration: "N/A",
    staffName,
    imageUrl: null,
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

async function executeCrossKick({
  userId,
  reason,
  staffName,
  imageUrl = null,
  replyTarget,
}) {
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

  await logCrossAction({
    configs,
    user,
    results,
    type: "Cross-Kick",
    emoji: "👢🌐",
    color: 0xff8c00,
    reason,
    duration: "N/A",
    staffName,
    imageUrl,
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

async function executeCrossCheck({ userId, replyTarget }) {
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
      // Check if they're banned
      const ban = await guild.bans.fetch(userId).catch(() => null);
      if (ban) {
        lines.push(
          `🔨 **${guild.name}** — Banned (reason: ${ban.reason ?? "none"})`,
        );
      } else {
        lines.push(`➖ **${guild.name}** — Not a member`);
      }
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

  await editReply(replyTarget, progressMsg, { content: "", embeds: [embed] });
}

// ─── APPEAL WEBHOOK HANDLER ───────────────────────────────────────────────────

async function handleAppealSubmission({
  type,
  userId,
  username,
  whyMutedBanned,
  whyAccept,
  additional,
}) {
  const configs = getAllGuildConfigs().filter(
    (c) => c.guildId && c.appealsChannelId,
  );

  if (configs.length === 0) {
    console.warn("[appeal] No guilds have appealsChannelId configured.");
    return;
  }

  const user = await client.users.fetch(userId).catch(() => null);
  const displayName = user?.username ?? username ?? userId;
  const avatarUrl = user?.displayAvatarURL() ?? null;

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${type === "mute" ? "Cross-Mute" : "Cross-Ban"} Appeal`)
    .setColor(Colors.Yellow)
    .setThumbnail(avatarUrl)
    .addFields(
      { name: "User", value: `${displayName} (\`${userId}\`)` },
      {
        name:
          "1. Why did you get " + (type === "mute" ? "muted" : "banned") + "?",
        value: whyMutedBanned || "No answer",
      },
      {
        name: "2. Why do you believe your appeal should be accepted?",
        value: whyAccept || "No answer",
      },
      {
        name: "3. Is there anything else you would like us to know?",
        value: additional || "N/A",
      },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`appeal_accept_${type}_${userId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`appeal_reject_${type}_${userId}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  for (const c of configs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) continue;

    const appealsChannel = await guild.channels
      .fetch(c.appealsChannelId)
      .catch(() => null);
    if (!appealsChannel) {
      console.warn(`[appeal] Appeals channel not found in guild ${guild.name}`);
      continue;
    }

    await appealsChannel.send({ embeds: [embed], components: [row] });
    console.log(
      `[appeal] Posted ${type} appeal for ${displayName} in guild ${guild.name}`,
    );
  }
}

// ─── EXPRESS WEBHOOK SERVER ───────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post("/appeal", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, userId, username, whyMutedBanned, whyAccept, additional } =
    req.body;

  if (!type || !userId) {
    return res
      .status(400)
      .json({ error: "Missing required fields: type, userId" });
  }

  res.status(200).json({ ok: true });

  // Handle async without blocking the response
  handleAppealSubmission({
    type,
    userId,
    username,
    whyMutedBanned,
    whyAccept,
    additional,
  }).catch((err) => console.error("[appeal] Error handling submission:", err));
});

app.get("/health", (req, res) =>
  res.json({ ok: true, bot: client.user?.tag ?? "not ready" }),
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐  Webhook server listening on port ${PORT}`),
);

// ─── AUDIT LOG LISTENER ───────────────────────────────────────────────────────

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  const { action, target, reason, changes } = entry;

  const reportsChannelId = getReportsChannelId(guild.id);
  if (!reportsChannelId) return;

  if (target?.id && crossActionInProgress.has(target.id)) return;

  let type, emoji, color, duration;

  if (action === AuditLogEvent.MemberBanAdd) {
    type = "Ban";
    emoji = "🔨";
    color = Colors.Red;
    duration = "Permanent";
  } else if (action === AuditLogEvent.MemberBanRemove) {
    type = "Unban";
    emoji = "✅";
    color = Colors.Green;
    duration = "N/A";
  } else if (action === AuditLogEvent.MemberKick) {
    type = "Kick";
    emoji = "👢";
    color = 0xff8c00;
    duration = "N/A";
  } else if (action === AuditLogEvent.MemberUpdate) {
    const timeoutChange = changes?.find(
      (c) => c.key === "communication_disabled_until",
    );
    if (!timeoutChange) return;
    if (timeoutChange.new) {
      type = "Mute";
      emoji = "🔇";
      color = Colors.Orange;
      duration = formatDuration(new Date(timeoutChange.new) - Date.now());
    } else {
      type = "Unmute";
      emoji = "🔊";
      color = Colors.Blue;
      duration = "N/A";
    }
  } else {
    return;
  }

  try {
    const reportsChannel = await guild.channels.fetch(reportsChannelId);
    if (!reportsChannel)
      return console.error(
        `[audit] Reports channel not found for guild ${guild.id}`,
      );

    const user = target;
    if (!user) return;

    const key = `${guild.id}:${user.id}`;
    const pending = pendingData.get(key);
    if (pending) pendingData.delete(key);

    const imageUrl = pending?.url ?? null;
    let staffName = pending?.staffName ?? null;

    if (!staffName) {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const logs = await guild.fetchAuditLogs({ limit: 5, type: action });
        const match = logs.entries.find((e) => e.target?.id === user.id);
        staffName = match?.executor?.username ?? "Unknown";
      } catch {
        staffName = "Unknown";
      }
    }

    const thread = await findOrCreateThread(reportsChannel, user);
    const embed = buildEmbed({
      type,
      emoji,
      color,
      reason: pending?.reason || reason || "No reason provided",
      duration,
      staffName,
      imageUrl,
    });
    await thread.send({ embeds: [embed] });
    console.log(
      `[${type.toLowerCase()}] Logged for ${user.username} (${user.id}) in guild ${guild.id} (${guild.name}) | staff: ${staffName}`,
    );
  } catch (err) {
    console.error(
      `[${type?.toLowerCase() ?? "audit"}] Error in guild ${guild.id} (${guild.name}):`,
      err,
    );
  }
});

// ─── SHARED LOGGING ───────────────────────────────────────────────────────────

async function logCrossAction({
  configs,
  user,
  results,
  type,
  emoji,
  color,
  reason,
  duration,
  staffName,
  imageUrl,
  filePrefix,
}) {
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
      imageUrl,
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildEmbed({
  type,
  emoji,
  color,
  reason,
  duration,
  staffName,
  imageUrl,
  extraField,
}) {
  const embed = new EmbedBuilder()
    .setTitle(`${emoji}  ${type}  ·  ${duration}`)
    .setColor(color)
    .addFields(
      { name: "Reason", value: reason },
      { name: "Staff", value: staffName },
    )
    .setTimestamp();
  if (extraField) embed.addFields(extraField);
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

function buildServerList(results, actionType) {
  const lines = results.map((r) => `${r.status}  |  ${r.name}  (${r.id})`);
  const timestamp = new Date().toUTCString();
  return `${actionType} — Server Report\nGenerated: ${timestamp}\n${"─".repeat(50)}\n${lines.join("\n")}`;
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  return n * multipliers[unit];
}

async function sendReply(target, content) {
  if (!target) return null;
  if (target.deferred || target.replied) return target.editReply(content);
  return target.reply(content);
}

async function editReply(target, progressMsg, content) {
  if (!target) return;
  try {
    if (target.deferred || target.replied) {
      await target.editReply(content);
    } else if (progressMsg?.edit) {
      await progressMsg.edit(content);
    }
  } catch (err) {
    console.error("[editReply] Error:", err.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
