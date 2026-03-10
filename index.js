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

/**
 * Reads per-guild config from individual env vars (preferred) or the legacy
 * GUILD_CONFIGS JSON blob (still supported for backward compatibility).
 *
 * New format (see .env.example):
 *   GUILD_IDS=id1,id2
 *   GUILD_<ID>_CHANNEL_ID=...
 *   GUILD_<ID>_APPEALS_CHANNEL_ID=...
 *   GUILD_<ID>_PREFIX=?
 *   GUILD_<ID>_TIER1_ROLES=roleId,roleId
 *   GUILD_<ID>_TIER2_ROLES=roleId
 *   GUILD_<ID>_TIER3_ROLES=roleId
 */
function readGuildEntry(guildId) {
  const prefix = `GUILD_${guildId}_`;
  const channelId = process.env[`${prefix}CHANNEL_ID`];
  if (!channelId) return null;

  const splitRoles = (key) =>
    (process.env[key] || "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

  return {
    guildId,
    channelId,
    appealsChannelId: process.env[`${prefix}APPEALS_CHANNEL_ID`] ?? null,
    prefix: process.env[`${prefix}PREFIX`] || "!",
    tier1Roles: splitRoles(`${prefix}TIER1_ROLES`),
    tier2Roles: splitRoles(`${prefix}TIER2_ROLES`),
    tier3Roles: splitRoles(`${prefix}TIER3_ROLES`),
  };
}

function normalizeLegacyEntry(guildId, entry) {
  // Legacy adminRoles → tier3Roles (full access)
  const adminRoles = typeof entry === "string" ? [] : entry.adminRoles || [];
  return {
    guildId,
    channelId: typeof entry === "string" ? entry : entry.channelId,
    appealsChannelId:
      typeof entry === "string" ? null : (entry.appealsChannelId ?? null),
    prefix:
      typeof entry === "string"
        ? process.env.COMMAND_PREFIX || "!"
        : entry.prefix || "!",
    tier1Roles: [],
    tier2Roles: [],
    tier3Roles: adminRoles,
  };
}

function getAllGuildConfigs() {
  // ── New per-guild env vars ──
  if (process.env.GUILD_IDS) {
    return process.env.GUILD_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map(readGuildEntry)
      .filter(Boolean);
  }

  // ── Legacy JSON blob ──
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    return Object.entries(configs).map(([guildId, entry]) =>
      normalizeLegacyEntry(guildId, entry),
    );
  }

  // ── Single-guild fallback ──
  return [
    {
      guildId: null,
      channelId: process.env.REPORTS_CHANNEL_ID,
      appealsChannelId: process.env.APPEALS_CHANNEL_ID ?? null,
      prefix: process.env.COMMAND_PREFIX || "!",
      tier1Roles: [],
      tier2Roles: [],
      tier3Roles: [],
    },
  ];
}

function getGuildConfig(guildId) {
  return getAllGuildConfigs().find((c) => c.guildId === guildId) ?? null;
}

function getReportsChannelId(guildId) {
  return getGuildConfig(guildId)?.channelId ?? null;
}

// ─── PERMISSION TIERS ─────────────────────────────────────────────────────────

/**
 * Which tier is required to run each cross-command.
 *   Tier 1 → crosscheck, crosskick
 *   Tier 2 → crossmute, crossunmute  (+ everything in tier 1)
 *   Tier 3 → crossban, crossunban    (+ everything in tier 1 & 2)
 */
const COMMAND_TIERS = {
  crosscheck: 1,
  crosskick: 1,
  crossmute: 2,
  crossunmute: 2,
  crossban: 3,
  crossunban: 3,
};

/**
 * Returns true if the member holds a role that grants access to the given
 * command.  A tier-N role grants access to all commands at tier N and below,
 * so we check tier N, N+1, … 3.
 *
 * If *no* roles are configured at any relevant tier, access is open to all.
 */
function hasTierAccess(member, config, command) {
  const requiredTier = COMMAND_TIERS[command] ?? 3;

  const allowedRoles = [];
  for (let tier = requiredTier; tier <= 3; tier++) {
    allowedRoles.push(...(config[`tier${tier}Roles`] || []));
  }

  if (allowedRoles.length === 0) return true; // no restrictions configured
  return member.roles.cache.some((r) => allowedRoles.includes(r.id));
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
      if (!hasTierAccess(message.member, config, command)) {
        return message.reply(
          "❌ You don't have permission to use this cross-command.",
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
      const sourceGuild = { id: message.guild.id, name: message.guild.name };
      const staffName = message.author.username;
      const staffId = message.author.id;

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
          staffName,
          staffId,
          imageUrl,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crossunmute") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossUnmute({
          userId,
          reason,
          staffName,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crossban") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossBan({
          userId,
          reason,
          staffName,
          staffId,
          imageUrl,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crossunban") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossUnban({
          userId,
          reason,
          staffName,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crosskick") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossKick({
          userId,
          reason,
          staffName,
          staffId,
          imageUrl,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crosscheck") {
        await executeCrossCheck({
          userId,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
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
    staffId: message.author.id,
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
        staffId: message.author.id,
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
  if (
    !hasTierAccess(
      member,
      config ?? { tier1Roles: [], tier2Roles: [], tier3Roles: [] },
      commandName,
    )
  ) {
    return interaction.reply({
      content: "❌ You don't have permission to use this cross-command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const userId = interaction.options.getString("userid");
  const reason =
    interaction.options.getString("reason") || "No reason provided";
  const staffName = member.user.username;
  const staffId = member.user.id;
  const imageUrl = interaction.options.getAttachment?.("image")?.url ?? null;
  const sourceGuild = { id: guild.id, name: guild.name };

  if (commandName === "crossmute") {
    const durationStr = interaction.options.getString("duration");
    await executeCrossMute({
      userId,
      durationStr,
      reason,
      staffName,
      staffId,
      imageUrl,
      sourceGuild,
      replyTarget: interaction,
    });
  } else if (commandName === "crossunmute") {
    await executeCrossUnmute({
      userId,
      reason,
      staffName,
      staffId,
      sourceGuild,
      replyTarget: interaction,
    });
  } else if (commandName === "crossban") {
    await executeCrossBan({
      userId,
      reason,
      staffName,
      staffId,
      imageUrl,
      sourceGuild,
      replyTarget: interaction,
    });
  } else if (commandName === "crossunban") {
    await executeCrossUnban({
      userId,
      reason,
      staffName,
      staffId,
      sourceGuild,
      replyTarget: interaction,
    });
  } else if (commandName === "crosskick") {
    await executeCrossKick({
      userId,
      reason,
      staffName,
      staffId,
      imageUrl,
      sourceGuild,
      replyTarget: interaction,
    });
  } else if (commandName === "crosscheck") {
    await executeCrossCheck({
      userId,
      staffId,
      sourceGuild,
      replyTarget: interaction,
    });
  }
});

// ─── APPEAL BUTTON HANDLER ────────────────────────────────────────────────────

async function handleAppealButton(interaction) {
  const { customId, guild, member } = interaction;
  if (!customId.startsWith("appeal_")) return;

  // customId format: appeal_accept_mute_{userId} or appeal_reject_mute_{userId}
  const parts = customId.split("_");
  const action = parts[1]; // accept or reject
  const type = parts[2]; // mute or ban
  const userId = parts[3];

  const config = getGuildConfig(guild.id);
  // Appeal buttons require at least tier-3 access (full admin)
  if (
    !hasTierAccess(
      member,
      config ?? { tier1Roles: [], tier2Roles: [], tier3Roles: [] },
      "crossban",
    )
  ) {
    return interaction.reply({
      content: "❌ You don't have permission to approve or reject appeals.",
      ephemeral: true,
    });
  }

  await interaction.deferUpdate();

  const originalEmbed = interaction.message.embeds[0];
  const staffName = member.user.username;
  const staffId = member.user.id;

  if (action === "accept") {
    const user = await client.users.fetch(userId).catch(() => null);

    if (type === "mute") {
      await executeCrossUnmute({
        userId,
        reason: "Appeal accepted",
        staffName,
        staffId,
        sourceGuild: { id: guild.id, name: guild.name },
        replyTarget: null,
      });
    } else if (type === "ban") {
      await executeCrossUnban({
        userId,
        reason: "Appeal accepted",
        staffName,
        staffId,
        sourceGuild: { id: guild.id, name: guild.name },
        replyTarget: null,
      });
    }

    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(Colors.Green)
      .addFields({
        name: "✅ Approved by",
        value: `<@${staffId}> (${staffName})`,
      });

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

    // Keep the View History link button if it exists
    const linkButton = interaction.message.components[0]?.components?.find(
      (c) => c.style === ButtonStyle.Link,
    );
    if (linkButton) {
      disabledRow.addComponents(ButtonBuilder.from(linkButton));
    }

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });
    console.log(
      `[appeal] Accepted ${type} appeal for ${user?.username ?? userId} by ${staffName} (${staffId})`,
    );
  } else if (action === "reject") {
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(Colors.Red)
      .addFields({
        name: "❌ Rejected by",
        value: `<@${staffId}> (${staffName})`,
      });

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

    const linkButton = interaction.message.components[0]?.components?.find(
      (c) => c.style === ButtonStyle.Link,
    );
    if (linkButton) {
      disabledRow.addComponents(ButtonBuilder.from(linkButton));
    }

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });
    console.log(
      `[appeal] Rejected ${type} appeal for ${userId} by ${staffName} (${staffId})`,
    );
  }
}

// ─── CROSS-COMMAND EXECUTORS ──────────────────────────────────────────────────

async function executeCrossMute({
  userId,
  durationStr,
  reason,
  staffName,
  staffId,
  imageUrl = null,
  sourceGuild,
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
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix: "crossmute",
  });

  await user
    .send(
      `🔇 You have been **cross-muted** across multiple servers.\n` +
        `**Reason:** ${reason}\n**Duration:** ${durationStr}\n\n` +
        `If you believe this was a mistake, you can appeal here:\n${CROSSMUTE_FORM}`,
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

async function executeCrossUnmute({
  userId,
  reason,
  staffName,
  staffId,
  sourceGuild,
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

async function executeCrossBan({
  userId,
  reason,
  staffName,
  staffId,
  imageUrl = null,
  sourceGuild,
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
    staffId,
    imageUrl,
    sourceGuild,
    filePrefix: "crossban",
  });

  await user
    .send(
      `🔨 You have been **cross-banned** from multiple servers.\n` +
        `**Reason:** ${reason}\n\n` +
        `If you believe this was a mistake, you can appeal here:\n${CROSSBAN_FORM}`,
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

async function executeCrossUnban({
  userId,
  reason,
  staffName,
  staffId,
  sourceGuild,
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

async function executeCrossKick({
  userId,
  reason,
  staffName,
  staffId,
  imageUrl = null,
  sourceGuild,
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

async function executeCrossCheck({
  userId,
  staffId,
  sourceGuild,
  replyTarget,
}) {
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

  if (sourceGuild) {
    embed.addFields({
      name: "Requested from",
      value: `${sourceGuild.name} (\`${sourceGuild.id}\`)`,
      inline: false,
    });
  }
  if (staffId) {
    embed.addFields({
      name: "Requested by",
      value: `<@${staffId}>`,
      inline: true,
    });
  }

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
        name: `1. Why did you get ${type === "mute" ? "muted" : "banned"}?`,
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

    // Find user's thread in reports channel for View History button
    let threadUrl = null;
    if (c.channelId) {
      const reportsChannel = await guild.channels
        .fetch(c.channelId)
        .catch(() => null);
      if (reportsChannel) {
        const active = await reportsChannel.threads
          .fetchActive()
          .catch(() => null);
        let thread = active?.threads.find((t) => t.name.startsWith(userId));
        if (!thread) {
          const archived = await reportsChannel.threads
            .fetchArchived({ fetchAll: true })
            .catch(() => null);
          thread = archived?.threads.find((t) => t.name.startsWith(userId));
        }
        if (thread)
          threadUrl = `https://discord.com/channels/${guild.id}/${thread.id}`;
      }
    }

    const buttons = [
      new ButtonBuilder()
        .setCustomId(`appeal_accept_${type}_${userId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`appeal_reject_${type}_${userId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
    ];

    if (threadUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel("View History")
          .setStyle(ButtonStyle.Link)
          .setURL(threadUrl),
      );
    }

    const row = new ActionRowBuilder().addComponents(...buttons);

    await appealsChannel.send({ embeds: [embed], components: [row] });
    console.log(
      `[appeal] Posted ${type} appeal for ${displayName} in guild ${guild.name}`,
    );
  }
}

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
  staffId,
  imageUrl,
  sourceGuild,
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildEmbed({
  type,
  emoji,
  color,
  reason,
  duration,
  staffName,
  staffId,
  imageUrl,
  sourceGuild,
  extraField,
}) {
  const staffValue = staffId ? `<@${staffId}> (${staffName})` : staffName;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji}  ${type}  ·  ${duration}`)
    .setColor(color)
    .addFields(
      { name: "Reason", value: reason },
      { name: "Staff", value: staffValue },
    )
    .setTimestamp();

  if (sourceGuild) {
    embed.addFields({
      name: "Server",
      value: `${sourceGuild.name} (\`${sourceGuild.id}\`)`,
      inline: false,
    });
  }

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
    let staffId = pending?.staffId ?? null;

    if (!staffName) {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const logs = await guild.fetchAuditLogs({ limit: 5, type: action });
        const match = logs.entries.find((e) => e.target?.id === user.id);
        staffName = match?.executor?.username ?? "Unknown";
        staffId = match?.executor?.id ?? null;
      } catch {
        staffName = "Unknown";
        staffId = null;
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
      staffId,
      imageUrl,
      // Audit log events are inherently per-guild; no sourceGuild field needed
    });
    await thread.send({ embeds: [embed] });
    console.log(
      `[${type.toLowerCase()}] Logged for ${user.username} (${user.id}) in guild ${guild.id} (${guild.name}) | staff: ${staffName} (${staffId ?? "unknown"})`,
    );
  } catch (err) {
    console.error(
      `[${type?.toLowerCase() ?? "audit"}] Error in guild ${guild.id} (${guild.name}):`,
      err,
    );
  }
});

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

// ─── START ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
