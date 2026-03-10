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

// Stores { url, staffName, timestamp } keyed by target userId
const pendingData = new Map();

// ─── READY ────────────────────────────────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`📋  Reports channel: ${process.env.REPORTS_CHANNEL_ID}`);
  console.log(`🔤  Prefix: ${process.env.COMMAND_PREFIX || "!"}`);
  console.log(`🔍  Watching ${client.guilds.cache.size} guild(s)`);
});

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  // Log EVERY message so we can confirm the bot is reading them
  if (message.guild) {
    console.log(
      `[msg-debug] channel=${message.channel.name} author=${message.author.username} bot=${message.author.bot} content=${message.content.slice(0, 80)}`,
    );
  }

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

  console.log(
    `[msg] ✅ Caught command="${command}" target=${userId} staff=${message.author.username}`,
  );
  pendingData.set(userId, {
    staffName: message.author.username,
    url: attachment?.url ?? null,
    timestamp: Date.now(),
  });
  setTimeout(() => pendingData.delete(userId), 15_000);

  // ── Handle !warn manually ──
  if (command === "warn") {
    const reason = args.slice(2).join(" ") || "No reason provided";
    try {
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return console.warn(`[warn] Could not fetch user ${userId}`);

      const reportsChannel = await message.guild.channels.fetch(
        process.env.REPORTS_CHANNEL_ID,
      );
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
      console.log(`[warn] Logged for ${user.username} (${userId})`);
    } catch (err) {
      console.error("[warn] Error:", err);
    }
  }
});

// ─── AUDIT LOG LISTENER ───────────────────────────────────────────────────────

client.on("guildAuditLogEntryCreate", async (entry, guild) => {
  const { action, target, reason, changes } = entry;

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
    const reportsChannel = await guild.channels.fetch(
      process.env.REPORTS_CHANNEL_ID,
    );
    if (!reportsChannel)
      return console.error("[audit] Reports channel not found!");

    const user = target;
    if (!user) return;

    const pending = pendingData.get(user.id);
    console.log(
      `[audit] type=${type} user=${user.id} pendingFound=${!!pending}`,
    );

    const imageUrl = pending?.url ?? null;
    let staffName = pending?.staffName ?? null;
    if (pending) pendingData.delete(user.id);

    // Last resort: fetch audit log manually (will still show Dyno if message wasn't caught)
    if (!staffName) {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        const logs = await guild.fetchAuditLogs({ limit: 5, type: action });
        const match = logs.entries.find((e) => e.target?.id === user.id);
        staffName = match?.executor?.username ?? "Unknown";
        console.log(`[audit] fallback executor fetched: ${staffName}`);
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
      `[${type.toLowerCase()}] Logged for ${user.username} (${user.id}) | staff: ${staffName}`,
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
