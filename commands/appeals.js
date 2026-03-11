"use strict";

const {
  EmbedBuilder,
  Colors,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require("discord.js");
const {
  getAllGuildConfigs,
  getGuildConfig,
  hasTierAccess,
} = require("../utils/config");
const { executeCrossUnmute, executeCrossUnban } = require("./cross");

async function handleAppealButton(client, crossActionInProgress, interaction) {
  const { customId, guild, member } = interaction;
  if (!customId.startsWith("appeal_")) return;

  // customId format: appeal_accept_mute_{userId} or appeal_reject_mute_{userId}
  const parts = customId.split("_");
  const action = parts[1]; // accept or reject
  const type = parts[2]; // mute or ban
  const userId = parts[3];

  const config = getGuildConfig(guild.id);
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
      await executeCrossUnmute(client, crossActionInProgress, {
        userId,
        reason: "Appeal accepted",
        staffName,
        staffId,
        sourceGuild: { id: guild.id, name: guild.name },
        replyTarget: null,
      });
    } else if (type === "ban") {
      await executeCrossUnban(client, crossActionInProgress, {
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

    const linkButton = interaction.message.components[0]?.components?.find(
      (c) => c.style === ButtonStyle.Link,
    );
    if (linkButton) disabledRow.addComponents(ButtonBuilder.from(linkButton));

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
    if (linkButton) disabledRow.addComponents(ButtonBuilder.from(linkButton));

    await interaction.editReply({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });
    console.log(
      `[appeal] Rejected ${type} appeal for ${userId} by ${staffName} (${staffId})`,
    );
  }
}

async function handleAppealSubmission(
  client,
  { type, userId, username, whyMutedBanned, whyAccept, additional },
) {
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

    // Find user's thread for the View History button
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

module.exports = { handleAppealButton, handleAppealSubmission };
