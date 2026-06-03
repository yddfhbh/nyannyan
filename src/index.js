import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const UPLOAD_COMMAND_NAME = '업로드';
const YEAR_CHOICES = ['26-1', '25-2', '25-1', '24-2', '24-1', '23'];
const ANSWER_EMOJIS = new Map([
  ['1️⃣', 1],
  ['2️⃣', 2],
  ['3️⃣', 3],
  ['4️⃣', 4],
]);

const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID || '',
  sourceChannelIds: parseCsv(process.env.SOURCE_CHANNEL_IDS),
  unitChannelPrefix: process.env.UNIT_CHANNEL_PREFIX || '',
  unitChannelMap: parseChannelMap(process.env.UNIT_CHANNEL_MAP),
};

const commands = [
  new SlashCommandBuilder()
    .setName(UPLOAD_COMMAND_NAME)
    .setDescription('문제를 단원 채널에 업로드합니다.')
    .addStringOption((option) =>
      option
        .setName('년도')
        .setDescription('시험 연도/회차')
        .setRequired(true)
        .addChoices(...YEAR_CHOICES.map((year) => ({ name: year, value: year }))),
    )
    .addIntegerOption((option) =>
      option
        .setName('문제번호')
        .setDescription('문제 번호')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50),
    )
    .addIntegerOption((option) =>
      option
        .setName('단원')
        .setDescription('보낼 단원 채널 번호')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(12),
    )
    .addAttachmentOption((option) =>
      option.setName('파일').setDescription('문제 이미지 또는 파일').setRequired(true),
    )
    .toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== UPLOAD_COMMAND_NAME) return;

  try {
    await handleUploadCommand(interaction);
  } catch (error) {
    console.error(error);
    await safeInteractionError(interaction, '업로드 처리 중 오류가 발생했습니다.');
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  const answer = ANSWER_EMOJIS.get(reaction.emoji.name);
  if (!answer) return;

  try {
    await handleAnswerReaction(reaction, user, answer);
  } catch (error) {
    console.error(error);
  }
});

async function handleUploadCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '서버 채널에서만 사용할 수 있습니다.', ephemeral: true });
    return;
  }

  if (!shouldWatchChannel(interaction.channelId)) {
    await interaction.reply({
      content: `이 명령어는 ${formatAllowedSourceChannels()} 채널에서만 사용할 수 있습니다.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const year = interaction.options.getString('년도', true);
  const problemNumber = interaction.options.getInteger('문제번호', true);
  const unit = String(interaction.options.getInteger('단원', true));
  const attachment = interaction.options.getAttachment('파일', true);

  const validationError = validateUploadOptions(year, problemNumber, unit);
  if (validationError) {
    await interaction.editReply(validationError);
    return;
  }

  const targetChannel = await findUnitChannel(interaction.guild, unit);
  if (!targetChannel) {
    await interaction.editReply(`단원 \`${unit}\`에 해당하는 채널을 찾지 못했습니다.`);
    return;
  }

  const botMember = await getBotMember(interaction.guild);
  const permissionError = getUploadPermissionError(targetChannel, botMember);
  if (permissionError) {
    await interaction.editReply(permissionError);
    return;
  }

  const problem = {
    year,
    problemNumber,
    unit,
    answer: null,
    uploaderId: interaction.user.id,
  };
  const postedMessage = await targetChannel.send({
    content: renderProblemContent(problem),
    files: [
      {
        attachment: attachment.url,
        name: sanitizeAttachmentName(attachment.name || `${year}-${problemNumber}.png`),
      },
    ],
    allowedMentions: { parse: [] },
  });

  await addAnswerReactions(postedMessage);
  await interaction.editReply(`업로드했습니다: ${postedMessage.url}`);
}

async function handleAnswerReaction(reaction, user, answer) {
  const fullReaction = await fetchFullReaction(reaction);
  const message = fullReaction.message;

  if (!message.guild || message.author?.id !== client.user.id) return;

  const problem = parsePublishedProblem(message.content || '');
  if (!problem) return;

  if (problem.uploaderId !== user.id) {
    await removeReactionFromUser(fullReaction, user);
    return;
  }

  await message.edit({
    content: renderProblemContent({
      ...problem,
      answer,
    }),
  });
  await removeOtherAnswerReactions(message, user, fullReaction.emoji.name);

  console.log(
    `Set answer ${answer} for ${problem.year} #${problem.problemNumber} unit ${problem.unit}`,
  );
}

async function registerCommands() {
  if (!client.application) {
    throw new Error('Client application is not ready.');
  }

  const guildIds = await resolveCommandGuildIds();
  if (guildIds.size === 0) {
    console.log('Registering global slash commands...');
    await client.application.commands.set(commands);
    console.log('Global slash commands registered.');
    return;
  }

  for (const guildId of guildIds) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      console.warn(`Cannot register commands for missing guild: ${guildId}`);
      continue;
    }

    console.log(`Registering slash commands for guild ${guild.name} (${guild.id})...`);
    await guild.commands.set(commands);
  }

  console.log('Guild slash commands registered.');
}

async function resolveCommandGuildIds() {
  const guildIds = new Set();
  if (config.guildId) guildIds.add(config.guildId);

  for (const channelId of config.sourceChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.guildId) guildIds.add(channel.guildId);
  }

  return guildIds;
}

async function findUnitChannel(guild, unit) {
  const mappedChannelId = config.unitChannelMap.get(unit);
  if (mappedChannelId) {
    const mappedChannel = await guild.channels.fetch(mappedChannelId).catch(() => null);
    if (isSendableTextChannel(mappedChannel)) return mappedChannel;
  }

  await guild.channels.fetch().catch(() => undefined);

  const expectedName = normalizeChannelName(`${config.unitChannelPrefix}${unit}`);
  return guild.channels.cache.find(
    (channel) => isSendableTextChannel(channel) && normalizeChannelName(channel.name) === expectedName,
  );
}

async function addAnswerReactions(message) {
  for (const emoji of ANSWER_EMOJIS.keys()) {
    await message.react(emoji);
  }
}

async function fetchFullReaction(reaction) {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  if (fullReaction.message.partial) {
    await fullReaction.message.fetch();
  }

  return fullReaction;
}

async function removeOtherAnswerReactions(message, user, selectedEmoji) {
  for (const emoji of ANSWER_EMOJIS.keys()) {
    if (emoji === selectedEmoji) continue;

    const otherReaction = message.reactions.cache.get(emoji);
    if (otherReaction) {
      await removeReactionFromUser(otherReaction, user);
    }
  }
}

async function removeReactionFromUser(reaction, user) {
  await reaction.users.remove(user.id).catch(() => undefined);
}

function parsePublishedProblem(content) {
  const titleMatch = content.match(
    /^(?<year>26-1|25-2|25-1|24-2|24-1|23)\/일반,\s*(?<problemNumber>\d{1,2})번\s*-(?<unit>\d{1,2})/m,
  );
  const answerMatch = content.match(/^정답:\s*(?:(?<answer>[1-4])번|미선택)$/m);
  const uploaderMatch = content.match(/^업로더:\s*<@!?(?<uploaderId>\d+)>$/m);

  if (!titleMatch?.groups || !uploaderMatch?.groups) return null;

  return {
    year: titleMatch.groups.year,
    problemNumber: Number(titleMatch.groups.problemNumber),
    unit: String(Number(titleMatch.groups.unit)),
    answer: answerMatch?.groups?.answer ? Number(answerMatch.groups.answer) : null,
    uploaderId: uploaderMatch.groups.uploaderId,
  };
}

function renderProblemContent(problem) {
  const answerText = problem.answer ? `${problem.answer}번` : '미선택';

  return [
    `${problem.year}/일반, ${problem.problemNumber}번 -${problem.unit}`,
    `정답: ${answerText}`,
    `업로더: <@${problem.uploaderId}>`,
  ].join('\n');
}

function validateUploadOptions(year, problemNumber, unit) {
  if (!YEAR_CHOICES.includes(year)) return '지원하지 않는 년도입니다.';
  if (!Number.isInteger(problemNumber) || problemNumber < 1 || problemNumber > 50) {
    return '문제 번호는 1번부터 50번까지만 가능합니다.';
  }

  const unitNumber = Number(unit);
  if (!Number.isInteger(unitNumber) || unitNumber < 1 || unitNumber > 12) {
    return '단원은 1부터 12까지만 가능합니다.';
  }

  return '';
}

function getUploadPermissionError(targetChannel, botMember) {
  const targetPermissions = targetChannel.permissionsFor(botMember);

  if (!targetPermissions?.has(PermissionFlagsBits.ViewChannel)) {
    return `대상 채널 <#${targetChannel.id}>을 볼 권한이 없습니다.`;
  }

  if (!targetPermissions?.has(PermissionFlagsBits.SendMessages)) {
    return `대상 채널 <#${targetChannel.id}>에 메시지를 보낼 권한이 없습니다.`;
  }

  if (!targetPermissions?.has(PermissionFlagsBits.AttachFiles)) {
    return `대상 채널 <#${targetChannel.id}>에 파일을 첨부할 권한이 없습니다.`;
  }

  if (!targetPermissions?.has(PermissionFlagsBits.AddReactions)) {
    return `대상 채널 <#${targetChannel.id}>에 반응을 추가할 권한이 없습니다.`;
  }

  if (!targetPermissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
    return `대상 채널 <#${targetChannel.id}>의 메시지 기록을 읽을 권한이 없습니다.`;
  }

  return '';
}

async function safeInteractionError(interaction, message) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(message).catch(() => undefined);
  } else {
    await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
  }
}

async function getBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function shouldWatchChannel(channelId) {
  return config.sourceChannelIds.length === 0 || config.sourceChannelIds.includes(channelId);
}

function formatAllowedSourceChannels() {
  if (config.sourceChannelIds.length === 0) return '모든';
  return config.sourceChannelIds.map((channelId) => `<#${channelId}>`).join(', ');
}

function isSendableTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && typeof channel.send === 'function');
}

function normalizeChannelName(value) {
  return value.trim().toLowerCase();
}

function sanitizeAttachmentName(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function parseCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseChannelMap(value) {
  const map = new Map();

  for (const item of parseCsv(value)) {
    const [unit, channelId] = item.split(':').map((part) => part.trim());
    const unitNumber = Number(unit);
    if (Number.isInteger(unitNumber) && unitNumber > 0 && channelId) {
      map.set(String(unitNumber), channelId);
    }
  }

  return map;
}

function assertConfig() {
  if (!config.token) {
    throw new Error('Missing required environment variable: DISCORD_TOKEN');
  }
}

assertConfig();
client.login(config.token).catch((error) => {
  console.error(error);
  process.exit(1);
});
