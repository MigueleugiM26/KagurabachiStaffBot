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
} = require("discord.js");
const { findOrCreateThread } = require("./utils/threads");
const { formatDuration } = require("./utils/format");

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

function getGuildConfig(guildId) {
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    const entry = configs[guildId];
    if (!entry) return null;
    if (typeof entry === "string")
      return {
        channelId: entry,
        prefix: process.env.COMMAND_PREFIX || "!",
        adminRoles: [],
      };
    return {
      channelId: entry.channelId,
      prefix: entry.prefix || "!",
      adminRoles: entry.adminRoles || [],
    };
  }
  return {
    channelId: process.env.REPORTS_CHANNEL_ID,
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
        ? { channelId: entry, prefix: "!", adminRoles: [] }
        : {
            channelId: entry.channelId,
            prefix: entry.prefix || "!",
            adminRoles: entry.adminRoles || [],
          }),
    }));
  }
  return [
    {
      guildId: null,
      channelId: process.env.REPORTS_CHANNEL_ID,
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
].map((c) => c.toJSON());

// ─── READY ────────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`🔍  Watching ${client.guilds.cache.size} guild(s)`);

  const configs = getAllGuildConfigs();
  for (const c of configs) {
    console.log(
      `📋  Guild ${c.guildId} → channel ${c.channelId} | prefix: ${c.prefix} | adminRoles: [${c.adminRoles.join(", ")}]`,
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
    const crossCommands = [
      "crossmute",
      "crossunmute",
      "crossban",
      "crossunban",
    ];

    if (crossCommands.includes(command)) {
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
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;
  const validCommands = ["crossmute", "crossunmute", "crossban", "crossunban"];
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
  }
});

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
    return sendReply(
      replyTarget,
      "❌ Invalid duration. Use formats like `10m`, `1h`, `7d`.",
    );

  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user)
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );

  const progressMsg = await sendReply(
    replyTarget,
    `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
  );

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

  const successCount = results.filter((r) => r.status === "✅ Muted").length;
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
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );

  const progressMsg = await sendReply(
    replyTarget,
    `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
  );

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
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );

  const progressMsg = await sendReply(
    replyTarget,
    `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
  );

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

  const successCount = results.filter((r) => r.status === "✅ Banned").length;
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
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );

  const progressMsg = await sendReply(
    replyTarget,
    `🔍 Searching for **${user.username}** in ${configs.length} server(s)...`,
  );

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
  await editReply(
    replyTarget,
    progressMsg,
    `✅ Cross-unban complete. Unbanned **${user.username}** in **${successCount}/${configs.length}** servers.\n\n${results.map((r) => `**${r.name}**: ${r.status}`).join("\n")}`,
  );
}

// Shared logging logic for all cross-commands
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
  if (target.deferred || target.replied) return target.editReply(content);
  return target.reply(content);
}

async function editReply(target, progressMsg, content) {
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
