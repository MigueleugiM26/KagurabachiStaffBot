require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  Colors,
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
// Supports multiple servers. GUILD_CONFIGS is a JSON map of guildId → reportsChannelId.
// Example: {"123456789": "987654321", "111222333": "444555666"}
// Falls back to legacy single-server REPORTS_CHANNEL_ID if GUILD_CONFIGS is not set.

function getReportsChannelId(guildId) {
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    return configs[guildId] ?? null;
  }
  return process.env.REPORTS_CHANNEL_ID ?? null;
}

// Stores { url, staffName, timestamp } keyed by "guildId:userId"
const pendingData = new Map();

// ─── READY ────────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`🔍  Watching ${client.guilds.cache.size} guild(s)`);
  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    for (const [guildId, channelId] of Object.entries(configs)) {
      console.log(`📋  Guild ${guildId} → reports channel ${channelId}`);
    }
  } else {
    console.log(`📋  Reports channel: ${process.env.REPORTS_CHANNEL_ID}`);
  }
});

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const prefix = process.env.COMMAND_PREFIX || "!";
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
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

  console.log(
    `[msg] ✅ command="${command}" target=${userId} staff=${message.author.username} guild=${message.guild.id}`,
  );
  pendingData.set(key, {
    staffName: message.author.username,
    url: attachment?.url ?? null,
    timestamp: Date.now(),
  });
  setTimeout(() => pendingData.delete(key), 15_000);

  // ── Handle !warn manually ──
  if (command === "warn") {
    const reason = args.slice(2).join(" ") || "No reason provided";
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

// ─── AUDIT LOG LISTENER ───────────────────────────────────────────────────────

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  const { action, target, reason, changes } = entry;

  // Skip guilds that have no reports channel configured
  const reportsChannelId = getReportsChannelId(guild.id);
  if (!reportsChannelId) return;

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
      reason: reason || "No reason provided",
      duration,
      staffName,
      imageUrl,
    });
    await thread.send({ embeds: [embed] });
    console.log(
      `[${type.toLowerCase()}] Logged for ${user.username} (${user.id}) in guild ${guild.id} | staff: ${staffName}`,
    );
  } catch (err) {
    console.error(`[${type?.toLowerCase() ?? "audit"}] Error:`, err);
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
}) {
  const embed = new EmbedBuilder()
    .setTitle(`${emoji}  ${type}  ·  ${duration}`)
    .setColor(color)
    .addFields(
      { name: "Reason", value: reason },
      { name: "Staff", value: staffName },
    )
    .setTimestamp();
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

// ─── START ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);
