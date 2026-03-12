"use strict";

// ─── GUILD CONFIG ─────────────────────────────────────────────────────────────

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
    errorsChannelId: process.env[`${prefix}ERRORS_CHANNEL_ID`] ?? null,
    prefix: process.env[`${prefix}PREFIX`] || "!",
    tier1Roles: splitRoles(`${prefix}TIER1_ROLES`),
    tier2Roles: splitRoles(`${prefix}TIER2_ROLES`),
    tier3Roles: splitRoles(`${prefix}TIER3_ROLES`),
    // ── Manga update settings (all optional) ──
    mangadexId: process.env[`${prefix}MANGADEX_ID`] ?? null,
    mangaUpdatesChannel: process.env[`${prefix}MANGAUPDATES_CHANNEL`] ?? null,
    mangaUpdatesRole: process.env[`${prefix}MANGAUPDATES_ROLE`] ?? null,
    mangaName: process.env[`${prefix}MANGA_NAME`] ?? null,
    mangaReleaseTime: process.env[`${prefix}MANGA_RELEASE_TIME`] ?? null,
  };
}

function normalizeLegacyEntry(guildId, entry) {
  const adminRoles = typeof entry === "string" ? [] : entry.adminRoles || [];
  return {
    guildId,
    channelId: typeof entry === "string" ? entry : entry.channelId,
    appealsChannelId:
      typeof entry === "string" ? null : (entry.appealsChannelId ?? null),
    errorsChannelId: null,
    prefix:
      typeof entry === "string"
        ? process.env.COMMAND_PREFIX || "!"
        : entry.prefix || "!",
    tier1Roles: [],
    tier2Roles: [],
    tier3Roles: adminRoles,
    mangadexId: null,
    mangaUpdatesChannel: null,
    mangaUpdatesRole: null,
    mangaName: null,
    mangaReleaseTime: null,
  };
}

function getAllGuildConfigs() {
  if (process.env.GUILD_IDS) {
    return process.env.GUILD_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map(readGuildEntry)
      .filter(Boolean);
  }

  if (process.env.GUILD_CONFIGS) {
    const configs = JSON.parse(process.env.GUILD_CONFIGS);
    return Object.entries(configs).map(([guildId, entry]) =>
      normalizeLegacyEntry(guildId, entry),
    );
  }

  return [
    {
      guildId: null,
      channelId: process.env.REPORTS_CHANNEL_ID,
      appealsChannelId: process.env.APPEALS_CHANNEL_ID ?? null,
      errorsChannelId: null,
      prefix: process.env.COMMAND_PREFIX || "!",
      tier1Roles: [],
      tier2Roles: [],
      tier3Roles: [],
      mangadexId: null,
      mangaUpdatesChannel: null,
      mangaUpdatesRole: null,
      mangaName: null,
      mangaReleaseTime: null,
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
 * Minimum tier required to run each command.
 *   Tier 1 → crosscheck, crosskick, reports, help  (lowest)
 *   Tier 2 → crossmute, crossunmute, mangacheck
 *   Tier 3 → crossban, crossunban                  (highest)
 */
const COMMAND_TIERS = {
  crosscheck: 1,
  crosskick: 1,
  reports: 1,
  help: 0, // available to everyone — handled specially in hasTierAccess
  mangacheck: 2,
  crossmute: 2,
  crossunmute: 2,
  crossban: 3,
  crossunban: 3,
};

/**
 * Central catalog used by &help / /help.
 * tier        — minimum tier required (mirrors COMMAND_TIERS)
 * usage       — shown in the single-command view
 * description — one-line summary
 * args        — argument descriptors for the detailed view
 */
const COMMAND_CATALOG = [
  {
    name: "crosscheck",
    tier: 1,
    usage: "&crosscheck <userID|@mention>",
    description:
      "Check a user's presence and info across all connected servers.",
    args: ["`userID` — The target user's ID or @mention."],
  },
  {
    name: "crosskick",
    tier: 1,
    usage: "&crosskick <userID|@mention> [reason]",
    description: "Kick a user from every server they share with the bot.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`reason` *(optional)* — Reason logged in the mod thread.",
    ],
  },
  {
    name: "reports",
    tier: 1,
    usage: "&reports <userID|@mention> [true|false]",
    description: "Show the full mod-action history for a user.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`full` *(optional, default true)* — `true` shows all connected servers; `false` shows only this server.",
    ],
  },
  {
    name: "crossmute",
    tier: 2,
    usage: "&crossmute <userID|@mention> <duration> [reason]",
    description: "Timeout a user across every connected server.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`duration` — e.g. `10m`, `1h`, `7d`.",
      "`reason` *(optional)* — Reason logged in the mod thread.",
    ],
  },
  {
    name: "crossunmute",
    tier: 2,
    usage: "&crossunmute <userID|@mention> [reason]",
    description: "Remove a timeout from a user across every connected server.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`reason` *(optional)* — Reason logged in the mod thread.",
    ],
  },
  {
    name: "mangacheck",
    tier: 2,
    usage: "/mangacheck  (slash command only)",
    description: "Manually check for a new manga chapter and post it if found.",
    args: [],
  },
  {
    name: "crossban",
    tier: 3,
    usage: "&crossban <userID|@mention> [reason]",
    description: "Ban a user from every connected server.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`reason` *(optional)* — Reason logged in the mod thread.",
    ],
  },
  {
    name: "crossunban",
    tier: 3,
    usage: "&crossunban <userID|@mention> [reason]",
    description: "Unban a user from every connected server.",
    args: [
      "`userID` — The target user's ID or @mention.",
      "`reason` *(optional)* — Reason logged in the mod thread.",
    ],
  },
  {
    name: "help",
    tier: 0,
    usage: "&help [command]",
    description: "Show all commands, or details about a specific one.",
    args: ["`command` *(optional)* — The command name to look up."],
  },
  {
    name: "contact",
    tier: 0,
    usage: "/contact",
    description: "Get the bot owner's contact for questions or issues.",
    args: [],
  },
  {
    name: "serverlist",
    tier: 0,
    usage: "/serverlist",
    description: "Show all servers this bot is currently in.",
    args: [],
  },
];

/**
 * Returns true if the member may use the given command.
 * Tier-N roles grant access to commands at tier N and below.
 * Help (tier 0) is open to everyone.
 * If no roles are configured at any relevant tier, access is open to all.
 */
function hasTierAccess(member, config, command) {
  const requiredTier = COMMAND_TIERS[command] ?? 3;
  if (requiredTier === 0) return true; // help is public

  const allowedRoles = [];
  for (let tier = requiredTier; tier <= 3; tier++) {
    allowedRoles.push(...(config[`tier${tier}Roles`] || []));
  }

  if (allowedRoles.length === 0) return true;
  return member.roles.cache.some((r) => allowedRoles.includes(r.id));
}

module.exports = {
  getAllGuildConfigs,
  getGuildConfig,
  getReportsChannelId,
  COMMAND_TIERS,
  COMMAND_CATALOG,
  hasTierAccess,
};
