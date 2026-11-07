const { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus } = require('@discordjs/voice');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 1. ตั้งค่าฐานข้อมูล SQLite ให้รองรับ Railway Persistent Volume
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'afk_data.db'));

// 🚀 เปิดใช้งาน WAL mode และปรับแต่งความเร็วสำหรับ Cloud/Persistent Volume
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS afk_stats (
    userId TEXT PRIMARY KEY,
    totalMs INTEGER DEFAULT 0
  )
`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

// 🔒 ล็อกสิทธิ์ Owner ID
const OWNER_ID = '911608960790974474';

// กำหนดขอบเขตยศ, จำนวนชั่วโมง, และเวลาเป็นมิลลิวินาที
const MILESTONES = [
  { name: '🤓 เด็กดิส (ออนดิส 1 ชม.)', hours: 1, ms: 1 * 60 * 60 * 1000 },
  { name: '🎮 เข้าเส้น (ออนดิส 5 ชม.)', hours: 5, ms: 5 * 60 * 60 * 1000 },
  { name: '🥩 เข้าเนื้อ (ออนดิส 10 ชม.)', hours: 10, ms: 10 * 60 * 60 * 1000 },
  { name: '😴 อันนี้มึงหลับ (ออนดิส 20 ชม.)', hours: 20, ms: 20 * 60 * 60 * 1000 },
  { name: '⁉ มึงว่างหรอ? (ออนดิส 50 ชม.)', hours: 50, ms: 50 * 60 * 60 * 1000 },
  { name: '⚰ มึงตายยัง (ออนดิส 100 ชม.)', hours: 100, ms: 100 * 60 * 60 * 1000 }
];

let connection = null;
const startTime = Date.now();
const sessionStarts = {}; 

function getUserTime(userId) {
  const row = db.prepare('SELECT totalMs FROM afk_stats WHERE userId = ?').get(userId);
  return row ? row.totalMs : 0;
}

function setUserTime(userId, setMs) {
  db.prepare(`
    INSERT INTO afk_stats (userId, totalMs) 
    VALUES (?, ?) 
    ON CONFLICT(userId) DO UPDATE SET totalMs = ?
  `).run(userId, setMs, setMs);
  return setMs;
}

function addUserTime(userId, addedMs) {
  const current = getUserTime(userId);
  const updated = current + addedMs;
  return setUserTime(userId, updated);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} วัน`);
  if (hours > 0) parts.push(`${hours} ชม.`);
  if (minutes > 0) parts.push(`${minutes} นาที`);
  if (days === 0 && hours === 0) parts.push(`${seconds} วิ.`);

  return parts.join(' ');
}

function getUptimeString() {
  return formatDuration(Date.now() - startTime);
}

// ฟังก์ชันตรวจเช็ค มอบยศ และประกาศแจ้งเตือน
async function checkAndAssignRoles(guild, member, totalMs, textChannel = null) {
  if (!guild || !member || member.user.bot) return;

  for (const milestone of MILESTONES) {
    if (totalMs >= milestone.ms) {
      let role = guild.roles.cache.find(r => r.name === milestone.name);
      
      if (!role) {
        try {
          role = await guild.roles.create({
            name: milestone.name,
            reason: 'AFK Milestone Role'
          });
        } catch (e) {
          console.error(`Failed to create role ${milestone.name}:`, e);
        }
      }

      if (role && !member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role);
          console.log(`Assigned role ${milestone.name} to ${member.displayName}`);

          if (textChannel) {
            await textChannel.send(
              `🎉 ดูไอนี้นะครับ! **${member}** แม้งอยู่ในห้องมา **${milestone.hours} ชั่วโมง** และได้รับยศพิเศษ **${milestone.name}** ไปครองแล้ว มึงภูมิใจมั้ย?? 👑✨`
            );
          }
        } catch (e) {
          console.error(`Failed to assign role to ${member.displayName}:`, e);
        }
      }
    }
  }
}

function connectToChannel() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  connection = joinVoiceChannel({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log('Connected to voice channel!');
  });
}

// ลงทะเบียน Slash Commands
const commands = [
  new SlashCommandBuilder().setName('afk').setDescription('เช็คสถานะและเวลา Uptime ของบอท'),
  new SlashCommandBuilder().setName('status').setDescription('เช็คสถานะและเวลา Uptime ของบอท'),
  new SlashCommandBuilder().setName('stats').setDescription('เช็คสถานะและเวลา Uptime ของบอท'),
  new SlashCommandBuilder().setName('top').setDescription('ดูอันดับ Top 5 คนที่อยู่ห้อง AFK นานที่สุด'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('ดูอันดับ Top 5 คนที่อยู่ห้อง AFK นานที่สุด'),
  new SlashCommandBuilder().setName('mytime').setDescription('เช็คเวลาสะสม AFK ส่วนตัวและลุ้นรับยศ'),
  new SlashCommandBuilder()
    .setName('userstats')
    .setDescription('เช็คเวลาสะสม AFK ของสมาชิกคนอื่นในเซิร์ฟเวอร์')
    .addUserOption(option => 
      option.setName('target')
        .setDescription('เลือกสมาชิกที่ต้องการดูสถิติ')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('settime')
    .setDescription('⚙️ [Owner Only] แก้ไขหรือกำหนดเวลาสะสม AFK ให้สมาชิก')
    .addUserOption(option => 
      option.setName('target')
        .setDescription('เลือกสมาชิกที่ต้องการปรับเวลา')
        .setRequired(true)
    )
    .addNumberOption(option => 
      option.setName('hours')
        .setDescription('จำนวนชั่วโมงที่ต้องการตั้งค่า (เช่น 1, 5, 10.5)')
        .setRequired(true)
        .setMinValue(0)
    )
].map(command => command.toJSON());

client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  connectToChannel();

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    const channel = guild.channels.cache.get(CHANNEL_ID);
    if (channel && channel.isVoiceBased()) {
      channel.members.forEach(member => {
        if (!member.user.bot) {
          sessionStarts[member.id] = Date.now();
        }
      });
    }
  }

  const updateStatus = () => {
    const uptime = getUptimeString();
    client.user.setActivity(`กูโดนใช้งานมา (${uptime}) ละ 😴`, { type: ActivityType.Custom });
  };

  updateStatus();
  setInterval(updateStatus, 30000);
});

// ตรวจจับการเข้า-ออกห้องเสียง
client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.member?.id || oldState.member?.id;
  if (!userId) return;

  if (userId === client.user.id) {
    if (!newState.channelId || newState.channelId !== CHANNEL_ID) {
      if (connection) {
        try { connection.destroy(); } catch (e) {}
      }
      setTimeout(() => connectToChannel(), 500);
    }
    return;
  }

  const isEnteringTarget = newState.channelId === CHANNEL_ID;
  const isLeavingTarget = oldState.channelId === CHANNEL_ID && newState.channelId !== CHANNEL_ID;

  if (isEnteringTarget) {
    sessionStarts[userId] = Date.now();
  } else if (isLeavingTarget && sessionStarts[userId]) {
    const duration = Date.now() - sessionStarts[userId];
    delete sessionStarts[userId];

    const newTotalMs = addUserTime(userId, duration);

    if (oldState.guild && oldState.member) {
      const textChannel = oldState.guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
      await checkAndAssignRoles(oldState.guild, oldState.member, newTotalMs, textChannel);
    }
  }
});

// จัดการการใช้งาน Slash Commands ทั้งหมด
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'afk' || commandName === 'status' || commandName === 'stats') {
    const uptime = getUptimeString();
    await interaction.reply(`⚡ **AFK Bot Status** ⚡\n🟢 กูออนมาแล้ว: **${uptime}** 🕒`);
  } 
  else if (commandName === 'top' || commandName === 'leaderboard') {
    const rows = db.prepare('SELECT userId, totalMs FROM afk_stats').all();
    const currentStats = {};
    
    rows.forEach(r => currentStats[r.userId] = r.totalMs);

    const now = Date.now();
    for (const [userId, start] of Object.entries(sessionStarts)) {
      currentStats[userId] = (currentStats[userId] || 0) + (now - start);
    }

    const sortedUsers = Object.entries(currentStats).sort((a, b) => b[1] - a[1]);

    if (sortedUsers.length === 0) {
      await interaction.reply(`🏆 **AFK Leaderboard** 🏆\nยังไม่มีประวัติในระบบ เข้าไปนั่งในห้อง AFK คนแรกได้เลย!`);
      return;
    }

    let description = '';
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

    for (let i = 0; i < Math.min(5, sortedUsers.length); i++) {
      const [userId, totalMs] = sortedUsers[i];
      let memberName = `User ID: ${userId}`;
      try {
        const member = await interaction.guild.members.fetch(userId);
        memberName = member.displayName;
      } catch (e) {}

      description += `${medals[i]} **${memberName}** — \`${formatDuration(totalMs)}\`\n`;
    }

    await interaction.reply(`🏆 **พวกไม่ออกดิส - Top 5 เซิร์ฟเวอร์** 🏆\n\n${description}`);
  }
  else if (commandName === 'mytime') {
    const userId = interaction.user.id;
    let totalMs = getUserTime(userId);

    if (sessionStarts[userId]) {
      totalMs += (Date.now() - sessionStarts[userId]);
    }

    if (totalMs === 0) {
      await interaction.reply({ content: `⏱️ คุณยังไม่มีประวัติการนั่งในห้อง AFK เลย!`, ephemeral: true });
    } else {
      const targetChannel = interaction.guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
      await checkAndAssignRoles(interaction.guild, interaction.member, totalMs, targetChannel);
      await interaction.reply(`⏱️ มึงอยู่ในห้อง Pok Pok ไปแล้ว: **${formatDuration(totalMs)}** ครับ ไอสัส! 🎉`);
    }
  }
  else if (commandName === 'userstats') {
    const targetUser = interaction.options.getUser('target');
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      await interaction.reply({ content: `❌ไม่พบผู้ใช้งานนี้ในเซิร์ฟเวอร์`, ephemeral: true });
      return;
    }

    let totalMs = getUserTime(targetUser.id);
    if (sessionStarts[targetUser.id]) {
      totalMs += (Date.now() - sessionStarts[targetUser.id]);
    }

    if (totalMs === 0) {
      await interaction.reply(`⏱️ **${targetMember.displayName}** ยังไม่มีประวัติการนั่งในห้อง AFK`);
    } else {
      await interaction.reply(`⏱️ **${targetMember.displayName}**:\nสิงอยู่ในห้องมาละ: **${formatDuration(totalMs)}** ครับไอสัส ไปเสือกของเขาทำไม?? ⁉`);
    }
  }
  else if (commandName === 'settime') {
    // 🔒 ตรวจสอบเฉพาะ ID ของคุณ
    if (interaction.user.id !== OWNER_ID) {
      await interaction.reply({ 
        content: `⛔ มึงไม่มีสิทธิ์ใช้คำสั่งนี้! เฉพาะเจ้าของบอทเท่านั้นครับ`, 
        ephemeral: true 
      });
      return;
    }

    const targetUser = interaction.options.getUser('target');
    const hours = interaction.options.getNumber('hours');
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) {
      await interaction.reply({ content: `❌ ไม่พบผู้ใช้งานนี้ในเซิร์ฟเวอร์ครับ!`, ephemeral: true });
      return;
    }

    const newMs = Math.floor(hours * 60 * 60 * 1000);
    setUserTime(targetUser.id, newMs);

    if (sessionStarts[targetUser.id]) {
      sessionStarts[targetUser.id] = Date.now();
    }

    const targetChannel = interaction.guild.channels.cache.get(ANNOUNCE_CHANNEL_ID);
    await checkAndAssignRoles(interaction.guild, targetMember, newMs, targetChannel);

    await interaction.reply({
      content: `✅ ปรับแก้เวลาสะสมของ **${targetMember.displayName}** เป็น **${hours} ชั่วโมง** (\`${formatDuration(newMs)}\`) เรียบร้อยแล้วครับ!`,
      ephemeral: true
    });
  }
});

client.login(process.env.BOT_TOKEN);
