async function findOrCreateThread(reportsChannel, user) {
  const threadName = `${user.id} (${user.username})`;

  // 1. Check active threads
  const active = await reportsChannel.threads.fetchActive();
  let thread = active.threads.find((t) => t.name.startsWith(user.id));

  // 2. Try archived threads (may fail on some forum channels — we skip if so)
  if (!thread) {
    try {
      const archived = await reportsChannel.threads.fetchArchived({
        fetchAll: true,
      });
      thread = archived.threads.find((t) => t.name.startsWith(user.id));
      if (thread) await thread.setArchived(false).catch(console.error);
    } catch {
      // No access to archived threads — ignore and create fresh if needed
    }
  }

  // 3. Create new thread
  if (!thread) {
    const isForum = reportsChannel.type === 15;
    if (isForum) {
      thread = await reportsChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        message: {
          content: `📁 Mod log thread for <@${user.id}> (\`${user.id}\`)`,
        },
        reason: `Mod log thread for ${user.username} (${user.id})`,
      });
    } else {
      thread = await reportsChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        reason: `Mod log thread for ${user.username} (${user.id})`,
      });
    }
    console.log(`[threads] Created new thread: ${threadName}`);
  }

  return thread;
}

module.exports = { findOrCreateThread };
