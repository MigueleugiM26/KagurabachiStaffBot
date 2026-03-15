require("dotenv").config();
const path = require("path");
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
const express = require("express");

// ── Utils ──────────────────────────────────────────────────────────────────────
const {
  getAllGuildConfigs,
  getGuildConfig,
  getReportsChannelId,
  hasTierAccess,
} = require("./utils/config");
const { findOrCreateThread } = require("./utils/threads");
const { formatDuration } = require("./utils/format");
const { buildEmbed } = require("./utils/helpers");
const { buildHelpPayload } = require("./utils/help");
const { executeReports } = require("./utils/reports");
const { initMangaSchedulers } = require("./utils/manga-scheduler");

// ── Commands ───────────────────────────────────────────────────────────────────
const {
  executeCrossMute,
  executeCrossUnmute,
  executeCrossBan,
  executeCrossUnban,
  executeCrossKick,
  executeCrossCheck,
} = require("./commands/cross");
const {
  handleAppealButton,
  handleAppealSubmission,
} = require("./commands/appeals");
const {
  executeCreateBoosterRole,
  executeEditBoosterColor,
  executeBoosterRoleImage,
  executeDeleteBoosterRole,
  executeClaimBoosterRole,
} = require("./commands/booster");
const { executePurgeAll } = require("./commands/purge");

// ─── CLIENT ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const CROSS_PREFIX = process.env.CROSS_PREFIX || "&";
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

  new SlashCommandBuilder()
    .setName("reports")
    .setDescription("Show all logged mod actions for a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) =>
      o
        .setName("userid")
        .setDescription("User ID to look up")
        .setRequired(true),
    )
    .addBooleanOption((o) =>
      o
        .setName("full")
        .setDescription("Include all connected servers (default: true)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("mangacheck")
    .setDescription("Manually check for a new chapter and post if found")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all commands or details about a specific one")
    .addStringOption((o) =>
      o
        .setName("command")
        .setDescription("Command name to look up (optional)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("contact")
    .setDescription(
      "Get the bot owner's contact for questions or issues about the bot",
    ),

  new SlashCommandBuilder()
    .setName("serverlist")
    .setDescription("Show all servers this bot is currently in"),

  new SlashCommandBuilder()
    .setName("archive")
    .setDescription(
      "Download a custom emoji or sticker and post it as an image",
    )
    .addStringOption((o) =>
      o
        .setName("input")
        .setDescription(
          "Paste a custom emoji (e.g. <:name:id>) or a sticker ID",
        )
        .setRequired(true),
    ),

  // ── Booster commands ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("createboosterrole")
    .setDescription("🚀 Boosters only — Create your own custom server role")
    .addStringOption((o) =>
      o.setName("name").setDescription("Role name").setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("Colour type (default: solid)")
        .setRequired(false)
        .addChoices(
          { name: "solid", value: "solid" },
          { name: "gradient", value: "gradient" },
          { name: "holographic", value: "holographic" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("color1")
        .setDescription("Primary hex colour, e.g. FF0000 or #FF0000")
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("color2")
        .setDescription("Secondary hex colour (gradient only)")
        .setRequired(false),
    )
    .addAttachmentOption((o) =>
      o
        .setName("icon")
        .setDescription("Image to use as role icon (server Level 2+ required)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("editboostercolor")
    .setDescription("🚀 Boosters only — Edit your booster role's colour/type")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("Colour type")
        .setRequired(true)
        .addChoices(
          { name: "solid", value: "solid" },
          { name: "gradient", value: "gradient" },
          { name: "holographic", value: "holographic" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("color1")
        .setDescription("Primary hex colour — not needed for holographic")
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName("color2")
        .setDescription("Secondary hex colour (required for gradient)")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("boosterroleimage")
    .setDescription(
      "🚀 Boosters only — Set your booster role's icon from an image",
    )
    .addAttachmentOption((o) =>
      o
        .setName("icon")
        .setDescription("Image to set as your role icon")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("deleteboosterrole")
    .setDescription("🚀 Boosters only — Delete your custom booster role"),

  new SlashCommandBuilder()
    .setName("claimboosterrole")
    .setDescription(
      "🚀 Boosters only — Claim an existing role (e.g. from Booster Bot) into this system",
    ),

  new SlashCommandBuilder()
    .setName("purgeall")
    .setDescription("Tier 3 — Delete every message in an allowlisted channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to purge (defaults to the current channel)")
        .setRequired(false),
    ),
].map((c) => c.toJSON());

// ─── MANGA SCHEDULER ──────────────────────────────────────────────────────────
let mangaScheduler = null;

// ─── READY ────────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  client.user.setActivity("Staff Bot | &help");
  console.log(`🔍  Watching ${client.guilds.cache.size} guild(s)`);

  const configs = getAllGuildConfigs();
  for (const c of configs) {
    console.log(
      `📋  Guild ${c.guildId} → reports: ${c.channelId} | appeals: ${c.appealsChannelId ?? "not set"} | prefix: ${c.prefix}`,
    );
  }

  mangaScheduler = initMangaSchedulers(
    client,
    configs,
    path.join(__dirname, "messages"),
  );

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

    if (c.botNickname) {
      try {
        const guild = client.guilds.cache.get(c.guildId);
        await guild?.members.me?.setNickname(c.botNickname);
        console.log(
          `✅  Nickname set to "${c.botNickname}" in guild ${c.guildId}`,
        );
      } catch (err) {
        console.error(
          `❌  Failed to set nickname in guild ${c.guildId}:`,
          err.message,
        );
      }
    }
  }
});

// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const config = getGuildConfig(message.guild.id);
  if (!config) return;

  const content = message.content;

  // ── Cross / bot commands ──
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
      "reports",
      "help",
      "contact",
      "serverlist",
      "archive",
      "mangacheck",
      "purgeall",
    ];

    // ── Booster commands — no userId, uses the message author ──────────────
    if (
      [
        "createboosterrole",
        "editboostercolor",
        "boosterroleimage",
        "deleteboosterrole",
        "claimboosterrole",
      ].includes(command)
    ) {
      const replyFn = (c) => message.reply(c);
      if (command === "createboosterrole") {
        const [roleName, type, color1, color2] = args.slice(1);
        if (!roleName)
          return message.reply(
            "❌ Usage: `&createBoosterRole <n> [type] [color1] [color2]`",
          );
        const imageAttachment = message.attachments.first() ?? null;
        const guildCfg = getGuildConfig(message.guild.id);
        return executeCreateBoosterRole(
          message.guild,
          message.member,
          {
            roleName,
            type: type?.toLowerCase(),
            color1,
            color2,
            imageAttachment,
            anchorRoleId: guildCfg?.boosterAnchorRoleId ?? null,
          },
          replyFn,
        );
      }
      if (command === "editboostercolor") {
        const [type, color1, color2] = args.slice(1);
        if (!type || !color1)
          return message.reply(
            "❌ Usage: `&editBoosterColor <type> <color1> [color2]`",
          );
        return executeEditBoosterColor(
          message.guild,
          message.member,
          { type: type.toLowerCase(), color1, color2 },
          replyFn,
        );
      }
      if (command === "boosterroleimage") {
        const imageAttachment = message.attachments.first() ?? null;
        return executeBoosterRoleImage(
          message.guild,
          message.member,
          imageAttachment,
          replyFn,
        );
      }
      if (command === "deleteboosterrole") {
        return executeDeleteBoosterRole(message.guild, message.member, replyFn);
      }
      if (command === "claimboosterrole") {
        const guildCfg2 = getGuildConfig(message.guild.id);
        const configRoleIds = [
          ...(guildCfg2?.tier1Roles ?? []),
          ...(guildCfg2?.tier2Roles ?? []),
          ...(guildCfg2?.tier3Roles ?? []),
        ];
        return executeClaimBoosterRole(
          message.guild,
          message.member,
          {
            configRoleIds,
            bottomAnchorRoleId: guildCfg2?.bottomBoosterAnchorRoleId ?? null,
            ignoredBoosterRoles: guildCfg2?.ignoredBoosterRoles ?? [],
          },
          replyFn,
          guildCfg2?.boosterAnchorRoleId ?? null,
        );
      }
    }

    if (validCrossCommands.includes(command)) {
      if (!hasTierAccess(message.member, config, command)) {
        return message.reply(
          "❌ You don't have permission to use this command.",
        );
      }

      // help doesn't need a userId
      if (command === "help") {
        const target = args[1]?.toLowerCase() ?? null;
        return message.reply(buildHelpPayload(target, config, message.guild));
      }

      // contact — no userId needed
      if (command === "contact") {
        const embed = new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle("📬  Contact the Bot Owner")
          .setDescription(
            "For questions, issues, or setup requests about this bot, reach out on Discord:\n\n" +
              "<@450842915024142374> (`450842915024142374`)",
          )
          .setFooter({
            text: "You can send a friend request or DM directly if you share a server.",
          });
        return message.reply({ embeds: [embed] });
      }

      // serverlist — no userId needed
      if (command === "serverlist") {
        const guilds = [...client.guilds.cache.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        const list = guilds
          .map((g) => `• **${g.name}** (\`${g.id}\`)`)
          .join("\n");
        const embed = new EmbedBuilder()
          .setColor(Colors.Blurple)
          .setTitle(`🌐  Servers (${guilds.length})`)
          .setDescription(list || "No servers found.");
        return message.reply({ embeds: [embed] });
      }

      // archive — no userId needed
      if (command === "archive") {
        const input = args.slice(1).join(" ");
        if (!input)
          return message.reply(
            `❌ Usage: \`${CROSS_PREFIX}archive <emoji or sticker ID>\``,
          );
        const target = await resolveArchiveTarget(client, input);
        if (!target)
          return message.reply(
            "❌ Couldn't recognise that. Paste a custom emoji (e.g. `<:name:id>`) or a sticker ID.",
          );
        if (target.type === "lottie")
          return message.reply(
            `❌ **${target.name}** is a Lottie sticker — Discord doesn't expose a static image for these.`,
          );
        return message.reply({
          files: [{ attachment: target.url, name: target.name }],
        });
      }

      // purgeall — no userId needed
      if (command === "purgeall") {
        const channelArg = args[1] ?? null;
        // Resolve channel from mention (<#id>) or bare ID, defaulting to current channel
        const channelId = channelArg
          ? channelArg.replace(/[<#>]/g, "")
          : message.channel.id;

        let targetChannel;
        try {
          targetChannel = await message.guild.channels.fetch(channelId);
        } catch {
          return message.reply(`❌ Could not find channel \`${channelId}\`.`);
        }
        if (!targetChannel?.isTextBased()) {
          return message.reply("❌ That channel is not a text channel.");
        }

        const allowedChannels = config.purgeChannels ?? [];
        const progressMsg = await message.reply(
          `🗑️ Starting purge of <#${targetChannel.id}>…`,
        );
        const editProgressFn = (content) => progressMsg.edit(content);

        return executePurgeAll({
          channel: targetChannel,
          allowedChannels,
          staffName: message.author.username,
          staffId: message.author.id,
          editProgressFn,
        });
      }

      if (command === "mangacheck") {
        if (!mangaScheduler)
          return message.reply(
            "⏳ Bot is still initializing, try again in a moment.",
          );
        const progress = await message.reply(
          "🔍 Checking for a new chapter...",
        );
        try {
          const result = await mangaScheduler.manualCheck(message.guild.id);
          if (result) {
            await progress.edit(
              `✅ Posted: **${result.chapterName}**\n${result.chapterLink}`,
            );
          } else {
            await progress.edit(
              "ℹ️ No new chapter found — either it's a break week, it was already posted, or manga updates aren't configured for this server.",
            );
          }
        } catch (err) {
          await progress.edit(`❌ Error: ${err.message}`);
        }
        return;
      }

      const userId = (args[1] ?? "").replace(/[<@!>]/g, "");
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
        await executeCrossMute(client, crossActionInProgress, {
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
        await executeCrossUnmute(client, crossActionInProgress, {
          userId,
          reason,
          staffName,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crossban") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossBan(client, crossActionInProgress, {
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
        await executeCrossUnban(client, crossActionInProgress, {
          userId,
          reason,
          staffName,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crosskick") {
        const reason = args.slice(2).join(" ") || "No reason provided";
        await executeCrossKick(client, crossActionInProgress, {
          userId,
          reason,
          staffName,
          staffId,
          imageUrl,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "crosscheck") {
        await executeCrossCheck(client, {
          userId,
          staffId,
          sourceGuild,
          replyTarget: message,
        });
      } else if (command === "reports") {
        const fullArg = args[2]?.toLowerCase();
        const full = fullArg === "false" ? false : true;
        await executeReports(client, {
          userId,
          sourceGuildId: message.guild.id,
          full,
          replyTarget: message,
        });
      }
      return;
    }
  }

  // ── Regular mod commands (audit log enrichment + warn) ──
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
  const parsedReason =
    (hasDuration ? args.slice(3) : args.slice(2)).join(" ") || null;

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

// ─── ARCHIVE HELPER ──────────────────────────────────────────────────────────

async function resolveArchiveTarget(client, input) {
  input = input.trim();

  // Custom emoji — <:name:id> or <a:name:id>
  const emojiMatch = input.match(/^<(a?):[^:]+:(\d+)>$/);
  if (emojiMatch) {
    const animated = emojiMatch[1] === "a";
    const id = emojiMatch[2];
    const ext = animated ? "gif" : "png";
    return {
      type: "emoji",
      url: `https://cdn.discordapp.com/emojis/${id}.${ext}`,
      name: `emoji_${id}.${ext}`,
    };
  }

  // Sticker — bare numeric ID
  if (/^\d+$/.test(input)) {
    try {
      const sticker = await client.fetchSticker(input);
      // StickerFormatType: PNG=1, APNG=2, Lottie=3, GIF=4
      if (sticker.format === 3)
        return { type: "lottie", url: null, name: sticker.name };
      const ext = sticker.format === 4 ? "gif" : "png";
      return {
        type: "sticker",
        url: `https://cdn.discordapp.com/stickers/${input}.${ext}`,
        name: `${sticker.name}.${ext}`,
      };
    } catch {
      return null;
    }
  }

  return null;
}

// ─── SLASH COMMAND HANDLER ────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleAppealButton(client, crossActionInProgress, interaction);
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
      "mangacheck",
      "reports",
      "help",
      "contact",
      "serverlist",
      "archive",
      "purgeall",
    ];

    // ── Booster commands — handled before validCommands check to avoid double-deferReply ──
    if (
      [
        "createboosterrole",
        "editboostercolor",
        "boosterroleimage",
        "deleteboosterrole",
        "claimboosterrole",
      ].includes(commandName)
    ) {
      await interaction.deferReply({ ephemeral: true });
      const replyFn = async (c) =>
        interaction.editReply(typeof c === "string" ? { content: c } : c);
      const boosterGuildCfg = getGuildConfig(guild.id);

      if (commandName === "createboosterrole") {
        const roleName = interaction.options.getString("name");
        const type = interaction.options.getString("type") ?? "solid";
        const color1 = interaction.options.getString("color1") ?? null;
        const color2 = interaction.options.getString("color2") ?? null;
        const imageAttachment =
          interaction.options.getAttachment("icon") ?? null;
        return executeCreateBoosterRole(
          guild,
          member,
          {
            roleName,
            type,
            color1,
            color2,
            imageAttachment,
            anchorRoleId: boosterGuildCfg?.boosterAnchorRoleId ?? null,
          },
          replyFn,
        );
      }
      if (commandName === "editboostercolor") {
        const type = interaction.options.getString("type");
        const color1 = interaction.options.getString("color1");
        const color2 = interaction.options.getString("color2") ?? null;
        return executeEditBoosterColor(
          guild,
          member,
          { type, color1, color2 },
          replyFn,
        );
      }
      if (commandName === "boosterroleimage") {
        const imageAttachment = interaction.options.getAttachment("icon");
        return executeBoosterRoleImage(guild, member, imageAttachment, replyFn);
      }
      if (commandName === "deleteboosterrole") {
        return executeDeleteBoosterRole(guild, member, replyFn);
      }
      if (commandName === "claimboosterrole") {
        const boosterGuildCfg2 = getGuildConfig(guild.id);
        const configRoleIds = [
          ...(boosterGuildCfg2?.tier1Roles ?? []),
          ...(boosterGuildCfg2?.tier2Roles ?? []),
          ...(boosterGuildCfg2?.tier3Roles ?? []),
        ];
        return executeClaimBoosterRole(
          guild,
          member,
          {
            configRoleIds,
            bottomAnchorRoleId:
              boosterGuildCfg2?.bottomBoosterAnchorRoleId ?? null,
            ignoredBoosterRoles: boosterGuildCfg2?.ignoredBoosterRoles ?? [],
          },
          replyFn,
          boosterGuildCfg2?.boosterAnchorRoleId ?? null,
        );
      }
    }

    if (!validCommands.includes(commandName)) return;

    // contact — open to everyone, no tier check needed
    if (commandName === "contact") {
      const embed = new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle("📬  Contact the Bot Owner")
        .setDescription(
          "For questions, issues, or setup requests about this bot, reach out on Discord:\n\n" +
            "<@450842915024142374> (`450842915024142374`)",
        )
        .setFooter({
          text: "You can send a friend request or DM directly if you share a server.",
        });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // serverlist — open to everyone, no tier check needed
    if (commandName === "serverlist") {
      const guilds = [...client.guilds.cache.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const list = guilds
        .map((g) => `• **${g.name}** (\`${g.id}\`)`)
        .join("\n");
      const embed = new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setTitle(`🌐  Servers (${guilds.length})`)
        .setDescription(list || "No servers found.");
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    const config = getGuildConfig(guild.id);
    if (
      !hasTierAccess(
        member,
        config ?? { tier1Roles: [], tier2Roles: [], tier3Roles: [] },
        commandName,
      )
    ) {
      return interaction.reply({
        content: "❌ You don't have permission to use this command.",
        ephemeral: true,
      });
    }

    // archive — tier 1
    if (commandName === "archive") {
      await interaction.deferReply();
      const input = interaction.options.getString("input") ?? "";
      const target = await resolveArchiveTarget(client, input);
      if (!target)
        return interaction.editReply(
          "❌ Couldn't recognise that. Paste a custom emoji (e.g. `<:name:id>`) or a sticker ID.",
        );
      if (target.type === "lottie")
        return interaction.editReply(
          `❌ **${target.name}** is a Lottie sticker — Discord doesn't expose a static image for these.`,
        );
      return interaction.editReply({
        files: [{ attachment: target.url, name: target.name }],
      });
    }

    // purgeall — tier 3
    if (commandName === "purgeall") {
      await interaction.deferReply({ ephemeral: false });

      const targetChannel =
        interaction.options.getChannel("channel") ?? interaction.channel;

      if (!targetChannel?.isTextBased()) {
        return interaction.editReply("❌ That channel is not a text channel.");
      }

      const purgeConfig = getGuildConfig(guild.id);
      const allowedChannels = purgeConfig?.purgeChannels ?? [];
      const editProgressFn = (content) => interaction.editReply(content);

      return executePurgeAll({
        channel: targetChannel,
        allowedChannels,
        staffName: member.user.username,
        staffId: member.user.id,
        editProgressFn,
      });
    }

    // help doesn't need deferReply or a userId
    if (commandName === "help") {
      const target =
        interaction.options.getString("command")?.toLowerCase() ?? null;
      return interaction.reply({
        ...buildHelpPayload(target, config, guild),
        ephemeral: false,
      });
    } else if (commandName === "mangacheck") {
      await interaction.deferReply();
      if (!mangaScheduler)
        return interaction.editReply(
          "⏳ Bot is still initializing, try again in a moment.",
        );
      try {
        const result = await mangaScheduler.manualCheck(guild.id);
        if (result) {
          await interaction.editReply(
            `✅ Posted: **${result.chapterName}**\n${result.chapterLink}`,
          );
        } else {
          await interaction.editReply(
            "ℹ️ No new chapter found — either it's a break week, it was already posted, or manga updates aren't configured for this server.",
          );
        }
      } catch (err) {
        await interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    await interaction.deferReply();

    const userId =
      (interaction.options.getString("userid") ?? "").replace(/[<@!>]/g, "") ||
      null;
    const reason =
      interaction.options.getString("reason") || "No reason provided";
    const staffName = member.user.username;
    const staffId = member.user.id;
    const imageUrl = interaction.options.getAttachment?.("image")?.url ?? null;
    const sourceGuild = { id: guild.id, name: guild.name };

    if (commandName === "crossmute") {
      const durationStr = interaction.options.getString("duration");
      await executeCrossMute(client, crossActionInProgress, {
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
      await executeCrossUnmute(client, crossActionInProgress, {
        userId,
        reason,
        staffName,
        staffId,
        sourceGuild,
        replyTarget: interaction,
      });
    } else if (commandName === "crossban") {
      await executeCrossBan(client, crossActionInProgress, {
        userId,
        reason,
        staffName,
        staffId,
        imageUrl,
        sourceGuild,
        replyTarget: interaction,
      });
    } else if (commandName === "crossunban") {
      await executeCrossUnban(client, crossActionInProgress, {
        userId,
        reason,
        staffName,
        staffId,
        sourceGuild,
        replyTarget: interaction,
      });
    } else if (commandName === "crosskick") {
      await executeCrossKick(client, crossActionInProgress, {
        userId,
        reason,
        staffName,
        staffId,
        imageUrl,
        sourceGuild,
        replyTarget: interaction,
      });
    } else if (commandName === "crosscheck") {
      await executeCrossCheck(client, {
        userId,
        staffId,
        sourceGuild,
        replyTarget: interaction,
      });
    } else if (commandName === "reports") {
      const full = interaction.options.getBoolean("full") ?? true;
      await executeReports(client, {
        userId,
        sourceGuildId: guild.id,
        full,
        replyTarget: interaction,
      });
    }
  } catch (err) {
    console.error("[interactionCreate] Unhandled error:", err);
    try {
      const msg = "❌ An unexpected error occurred. Please try again.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch {
      // interaction already expired — nothing we can do
    }
  }
});

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

// ─── BOOSTER WELCOME ─────────────────────────────────────────────────────────

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  // Only fire when premium status is newly gained (null → timestamp)
  const justBoosted =
    !oldMember.premiumSinceTimestamp && newMember.premiumSinceTimestamp;
  if (!justBoosted) return;

  const guildId = newMember.guild.id;
  const channelId = process.env[`GUILD_${guildId}_BOOSTER_WELCOME_CHANNEL_ID`];
  if (!channelId) return;

  try {
    const channel = await newMember.guild.channels.fetch(channelId);
    if (!channel) {
      return console.error(
        `[booster-welcome] Channel ${channelId} not found in guild ${guildId}`,
      );
    }

    await channel.send(
      `🚀 Thank you for boosting **${newMember.guild.name}**, <@${newMember.id}>! ` +
        `Check the pinned messages in this channel to learn how to set up your custom booster role.`,
    );

    console.log(
      `[booster-welcome] Welcomed new booster ${newMember.user.username} (${newMember.id}) in guild ${guildId}`,
    );
  } catch (err) {
    console.error(
      `[booster-welcome] Error sending welcome in guild ${guildId}:`,
      err.message,
    );
  }
});

// ─── EXPRESS WEBHOOK SERVER ───────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post("/appeal", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const { type, userId, username, whyMutedBanned, whyAccept, additional } =
    req.body;
  if (!type || !userId)
    return res
      .status(400)
      .json({ error: "Missing required fields: type, userId" });

  res.status(200).json({ ok: true });
  handleAppealSubmission(client, {
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
