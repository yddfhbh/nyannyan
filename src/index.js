import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const UPLOAD_COMMAND_NAME = '업로드';
const MOVE_COMMAND_NAME = '이동';
const REPLY_MOVE_MIN_UNIT = 1;
const REPLY_MOVE_MAX_UNIT = 10;
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
  problemCategoryId: process.env.PROBLEM_CATEGORY_ID || '1509459977801044029',
  unitChannelPrefix: process.env.UNIT_CHANNEL_PREFIX || '',
  unitChannelMap: parseChannelMap(process.env.UNIT_CHANNEL_MAP),
};

const liveNotifierConfig = {
  alertChannelId: process.env.LIVE_ALERT_CHANNEL_ID || '1516330161178546201',
  intervalMs: Math.max(30_000, Number(process.env.LIVE_CHECK_INTERVAL_MS || 60_000)),
  batchSize: Math.max(1, Number(process.env.LIVE_CHECK_BATCH_SIZE || 100)),
  baseUrl: process.env.VSTOCK_BASE_URL || 'https://virtual-stock.xyz',
  stockPageSize: Math.max(1, Number(process.env.VSTOCK_STOCKS_PAGE_SIZE || 100)),
  stockScanPages: Math.max(1, Number(process.env.VSTOCK_STOCKS_SCAN_PAGES || 30)),
  notifyOnBoot: parseBoolean(process.env.VSTOCK_NOTIFY_ON_BOOT),
  poolRefreshMs: Math.max(60_000, Number(process.env.VSTOCK_POOL_REFRESH_MS || 10 * 60_000)),
  chzzkResolveDelayMs: Math.max(100, Number(process.env.CHZZK_RESOLVE_DELAY_MS || 250)),
  chzzkResolveMaxPerRefresh: Math.max(1, Number(process.env.CHZZK_RESOLVE_MAX_PER_REFRESH || 200)),
  chzzkSearchRequireExact: parseBoolean(process.env.CHZZK_SEARCH_REQUIRE_EXACT),
};

let liveNotifierStarted = false;
let liveCheckRunning = false;
let livePoolRefreshing = false;
let liveStateInitialized = false;
let lastLivePoolRefreshAt = 0;
let streamerPool = [];
let shuffledStreamerQueue = [];
const liveStateByChannelId = new Map();
const chzzkChannelIdByNameCache = new Map();
const chzzkResolveMissCache = new Set();

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
        .setMaxValue(60),
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
  new SlashCommandBuilder()
    .setName(MOVE_COMMAND_NAME)
    .setDescription('카테고리 안의 특정 단원 문제를 다른 단원 채널로 옮깁니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName('기존단원')
        .setDescription('옮길 문제의 현재 단원')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(12),
    )
    .addIntegerOption((option) =>
      option
        .setName('새단원')
        .setDescription('옮겨갈 단원')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(12),
    )
    .addBooleanOption((option) =>
      option.setName('미리보기').setDescription('실제로 옮기지 않고 대상 개수만 확인합니다.'),
    )
    .toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
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

  startLiveNotifier();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === UPLOAD_COMMAND_NAME) {
      await handleUploadCommand(interaction);
      return;
    }

    if (interaction.commandName === MOVE_COMMAND_NAME) {
      await handleMoveCommand(interaction);
    }
  } catch (error) {
    console.error(error);
    await safeInteractionError(interaction, '명령 처리 중 오류가 발생했습니다.');
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

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  try {
    await handleReplyMoveMessage(message);
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
    answerInHeader: false,
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
  await interaction.deleteReply().catch(() => undefined);
}

async function handleMoveCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '서버 채널에서만 사용할 수 있습니다.', ephemeral: true });
    return;
  }

  if (!canManageMessages(interaction)) {
    await interaction.reply({ content: '`메시지 관리` 권한이 필요합니다.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const fromUnit = String(interaction.options.getInteger('기존단원', true));
  const toUnit = String(interaction.options.getInteger('새단원', true));
  const previewOnly = interaction.options.getBoolean('미리보기') ?? false;

  if (fromUnit === toUnit) {
    await interaction.editReply('기존 단원과 새 단원이 같습니다.');
    return;
  }

  const targetChannel = await findUnitChannel(interaction.guild, toUnit);
  if (!targetChannel) {
    await interaction.editReply(`새 단원 \`${toUnit}\`에 해당하는 채널을 찾지 못했습니다.`);
    return;
  }

  const botMember = await getBotMember(interaction.guild);
  const targetPermissionError = getUploadPermissionError(targetChannel, botMember);
  if (targetPermissionError) {
    await interaction.editReply(targetPermissionError);
    return;
  }

  const scanChannels = await getProblemCategoryChannels(interaction.guild);
  if (scanChannels.length === 0) {
    await interaction.editReply(`카테고리 \`${config.problemCategoryId}\` 안에서 스캔할 채널을 찾지 못했습니다.`);
    return;
  }

  const sourcePermissionError = getCategoryScanPermissionError(scanChannels, botMember);
  if (sourcePermissionError) {
    await interaction.editReply(sourcePermissionError);
    return;
  }

  await interaction.editReply(
    `${scanChannels.length}개 채널에서 \`${fromUnit}\`단원 문제를 스캔합니다...`,
  );

  const result = await moveProblemsBetweenUnits({
    scanChannels,
    targetChannel,
    fromUnit,
    toUnit,
    previewOnly,
  });

  await interaction.editReply(formatMoveResult(result, fromUnit, toUnit, targetChannel, previewOnly));
}

async function handleAnswerReaction(reaction, user, answer) {
  const fullReaction = await fetchFullReaction(reaction);
  const message = fullReaction.message;

  if (!message.guild || message.author?.id !== client.user.id) return;

  const problem = parsePublishedProblem(message.content || '');
  if (!problem) return;

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

async function handleReplyMoveMessage(message) {
  const toUnit = parseReplyMoveUnit(message.content);
  if (!toUnit || !message.reference?.messageId) return;
  if (!canManageMessagesInChannel(message.channel, message.member)) return;

  const referencedMessage = await fetchReferencedMessage(message);
  if (!referencedMessage || referencedMessage.author?.id !== client.user.id) return;

  const problem = parseProblemFromMessage(referencedMessage);
  if (!problem) return;

  const targetChannel = await findUnitChannel(message.guild, toUnit);
  if (!targetChannel) {
    console.warn(`Cannot move message ${referencedMessage.id}: missing unit channel ${toUnit}`);
    return;
  }

  const botMember = await getBotMember(message.guild);
  const permissionError = getReplyMovePermissionError(referencedMessage, targetChannel, botMember);
  if (permissionError) {
    console.warn(`Cannot move message ${referencedMessage.id}: ${permissionError}`);
    return;
  }

  await moveSingleProblemMessage(referencedMessage, problem, targetChannel, toUnit);
  await message.delete().catch(() => undefined);

  console.log(
    `Moved replied problem ${problem.year} #${problem.problemNumber} to unit ${toUnit}`,
  );
}

async function moveProblemsBetweenUnits({ scanChannels, targetChannel, fromUnit, toUnit, previewOnly }) {
  const result = {
    scannedChannels: scanChannels.length,
    scannedMessages: 0,
    matchedMessages: 0,
    movedMessages: 0,
    editedMessages: 0,
    failedMessages: 0,
  };

  for (const channel of scanChannels) {
    for await (const message of fetchAllChannelMessages(channel)) {
      result.scannedMessages += 1;

      const problem = parseProblemFromMessage(message);
      if (!problem || problem.unit !== fromUnit) continue;

      result.matchedMessages += 1;
      if (previewOnly) continue;

      try {
        await moveSingleProblemMessage(message, problem, targetChannel, toUnit);
        if (message.channelId === targetChannel.id && message.author.id === client.user.id) {
          result.editedMessages += 1;
        } else {
          result.movedMessages += 1;
        }
      } catch (error) {
        result.failedMessages += 1;
        console.error(`Failed to move message ${message.id}:`, error);
      }
    }
  }

  return result;
}

async function moveSingleProblemMessage(message, problem, targetChannel, toUnit) {
  const movedProblem = {
    ...problem,
    unit: toUnit,
  };

  if (message.channelId === targetChannel.id && message.author.id === client.user.id) {
    await message.edit({ content: renderProblemContent(movedProblem) });
    await addMissingAnswerReactions(message);
    return;
  }

  const files = [...message.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: sanitizeAttachmentName(attachment.name || `${problem.year}-${problem.problemNumber}.png`),
  }));

  const postedMessage = await targetChannel.send({
    content: renderProblemContent(movedProblem),
    files,
    allowedMentions: { parse: [] },
  });

  await addAnswerReactions(postedMessage);
  await message.delete();
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

async function getProblemCategoryChannels(guild) {
  await guild.channels.fetch().catch(() => undefined);

  return [...guild.channels.cache.values()]
    .filter(
      (channel) =>
        channel.parentId === config.problemCategoryId &&
        isScannableTextChannel(channel) &&
        !channel.isThread?.(),
    )
    .sort((a, b) => {
      if (a.rawPosition !== b.rawPosition) return a.rawPosition - b.rawPosition;
      return a.name.localeCompare(b.name);
    });
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

async function addMissingAnswerReactions(message) {
  for (const emoji of ANSWER_EMOJIS.keys()) {
    if (!message.reactions.cache.has(emoji)) {
      await message.react(emoji);
    }
  }
}

async function* fetchAllChannelMessages(channel) {
  let before;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      yield message;
    }

    before = batch.last().id;
    if (batch.size < 100) break;
  }
}

async function fetchFullReaction(reaction) {
  const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
  if (fullReaction.message.partial) {
    await fullReaction.message.fetch();
  }

  return fullReaction;
}

async function fetchReferencedMessage(message) {
  const messageId = message.reference?.messageId;
  if (!messageId) return null;

  const channelId = message.reference.channelId || message.channelId;
  const channel =
    channelId === message.channelId
      ? message.channel
      : await client.channels.fetch(channelId).catch(() => null);
  if (!isScannableTextChannel(channel)) return null;

  return channel.messages.fetch(messageId).catch(() => null);
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

function parseProblemFromMessage(message) {
  const header = parseProblemHeader(message.content || '');
  if (!header) return null;

  const answerMatch = (message.content || '').match(/^정답:\s*(?:(?<answer>[1-4])번|미선택)$/m);
  const answer = answerMatch?.groups?.answer
    ? Number(answerMatch.groups.answer)
    : header.answer;

  return {
    year: header.year,
    problemNumber: header.problemNumber,
    unit: header.unit,
    answer,
    answerInHeader: Boolean(header.answer),
  };
}

function parsePublishedProblem(content) {
  const titleMatch = parseProblemHeader(content);
  const answerMatch = content.match(/^정답:\s*(?:(?<answer>[1-4])번|미선택)$/m);

  if (!titleMatch) return null;

  return {
    year: titleMatch.year,
    problemNumber: titleMatch.problemNumber,
    unit: titleMatch.unit,
    answer: answerMatch?.groups?.answer ? Number(answerMatch.groups.answer) : titleMatch.answer,
    answerInHeader: Boolean(titleMatch.answer),
  };
}

function parseProblemHeader(content) {
  const match = content.match(
    /^(?<year>26-1|25-2|25-1|24-2|24-1|23)\/일반,\s*(?<problemNumber>\d{1,2})번\s*-\s*(?<unit>\d{1,2})(?:\s*,\s*(?<answer>[1-4])번)?/m,
  );

  if (!match?.groups) return null;

  return {
    year: match.groups.year,
    problemNumber: Number(match.groups.problemNumber),
    unit: String(Number(match.groups.unit)),
    answer: match.groups.answer ? Number(match.groups.answer) : null,
  };
}

function renderProblemContent(problem) {
  const answerText = problem.answer ? `${problem.answer}번` : '미선택';
  const answerSuffix = problem.answerInHeader && problem.answer ? `, ${problem.answer}번` : '';
  const title = `${problem.year}/일반, ${problem.problemNumber}번 -${problem.unit}${answerSuffix}`;
  const lines = [title];

  if (!answerSuffix) {
    lines.push(`정답: ${answerText}`);
  }

  return lines.join('\n');
}

function formatMoveResult(result, fromUnit, toUnit, targetChannel, previewOnly) {
  if (previewOnly) {
    return [
      '미리보기 완료',
      `스캔 채널: ${result.scannedChannels}개`,
      `스캔 메시지: ${result.scannedMessages}개`,
      `이동 대상: ${result.matchedMessages}개`,
      `대상 채널: <#${targetChannel.id}>`,
    ].join('\n');
  }

  return [
    `\`${fromUnit}\`단원 문제를 \`${toUnit}\`단원으로 이동했습니다.`,
    `스캔 채널: ${result.scannedChannels}개`,
    `스캔 메시지: ${result.scannedMessages}개`,
    `대상 메시지: ${result.matchedMessages}개`,
    `이동: ${result.movedMessages}개`,
    `같은 채널에서 수정: ${result.editedMessages}개`,
    `실패: ${result.failedMessages}개`,
    `대상 채널: <#${targetChannel.id}>`,
  ].join('\n');
}

function validateUploadOptions(year, problemNumber, unit) {
  if (!YEAR_CHOICES.includes(year)) return '지원하지 않는 년도입니다.';
  if (!Number.isInteger(problemNumber) || problemNumber < 1 || problemNumber > 60) {
    return '문제 번호는 1번부터 60번까지만 가능합니다.';
  }

  const unitNumber = Number(unit);
  if (!Number.isInteger(unitNumber) || unitNumber < 1 || unitNumber > 12) {
    return '단원은 1부터 12까지만 가능합니다.';
  }

  return '';
}

function getReplyMovePermissionError(sourceMessage, targetChannel, botMember) {
  const sourcePermissions = sourceMessage.channel.permissionsFor(botMember);

  if (!sourcePermissions?.has(PermissionFlagsBits.ViewChannel)) {
    return `원본 채널 <#${sourceMessage.channelId}>을 볼 권한이 없습니다.`;
  }

  if (!sourcePermissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
    return `원본 채널 <#${sourceMessage.channelId}>의 메시지 기록을 읽을 권한이 없습니다.`;
  }

  if (!sourcePermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return `원본 채널 <#${sourceMessage.channelId}>에서 메시지를 지울 권한이 없습니다.`;
  }

  return getUploadPermissionError(targetChannel, botMember);
}

function getCategoryScanPermissionError(channels, botMember) {
  const missingChannels = channels
    .map((channel) => ({
      channel,
      permissions: channel.permissionsFor(botMember),
    }))
    .filter(
      ({ permissions }) =>
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions?.has(PermissionFlagsBits.ReadMessageHistory) ||
        !permissions?.has(PermissionFlagsBits.ManageMessages),
    )
    .map(({ channel }) => `<#${channel.id}>`);

  if (missingChannels.length === 0) return '';

  const visible = missingChannels.slice(0, 5).join(', ');
  const suffix = missingChannels.length > 5 ? ` 외 ${missingChannels.length - 5}개` : '';
  return `카테고리 안의 일부 채널에서 \`채널 보기\`, \`메시지 기록 읽기\`, \`메시지 관리\` 권한이 부족합니다: ${visible}${suffix}`;
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

function canManageMessages(interaction) {
  return hasManageMessagesPermission(interaction.memberPermissions);
}

function canManageMessagesInChannel(channel, member) {
  if (!channel || !member) return false;
  return hasManageMessagesPermission(channel.permissionsFor(member));
}

function hasManageMessagesPermission(permissions) {
  return Boolean(
    permissions?.has(PermissionFlagsBits.Administrator) ||
      permissions?.has(PermissionFlagsBits.ManageMessages),
  );
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

function isScannableTextChannel(channel) {
  return Boolean(isSendableTextChannel(channel) && channel.messages?.fetch);
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

function parseReplyMoveUnit(content) {
  const trimmed = content.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return null;

  const unit = Number(trimmed);
  if (
    !Number.isInteger(unit) ||
    unit < REPLY_MOVE_MIN_UNIT ||
    unit > REPLY_MOVE_MAX_UNIT
  ) {
    return null;
  }

  return String(unit);
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

function startLiveNotifier() {
  if (liveNotifierStarted) return;
  liveNotifierStarted = true;

  if (!liveNotifierConfig.alertChannelId) {
    console.log('Live notifier disabled: LIVE_ALERT_CHANNEL_ID is empty.');
    return;
  }

  console.log(
    [
      'Live notifier enabled.',
      `channel=${liveNotifierConfig.alertChannelId}`,
      `interval=${liveNotifierConfig.intervalMs}ms`,
      `batch=${liveNotifierConfig.batchSize}`,
      `poolRefresh=${liveNotifierConfig.poolRefreshMs}ms`,
    ].join(' '),
  );

  runLiveCheck({ isBoot: true }).catch((error) => {
    console.error('Initial live check failed:', error);
  });

  setInterval(() => {
    runLiveCheck().catch((error) => {
      console.error('Live check failed:', error);
    });
  }, liveNotifierConfig.intervalMs);
}

async function runLiveCheck({ isBoot = false } = {}) {
  if (liveCheckRunning) return;
  liveCheckRunning = true;

  try {
    const alertChannel = await client.channels
      .fetch(liveNotifierConfig.alertChannelId)
      .catch(() => null);

    if (!isSendableTextChannel(alertChannel)) {
      console.warn(`Live alert channel is not sendable: ${liveNotifierConfig.alertChannelId}`);
      return;
    }

    await refreshStreamerPoolIfNeeded();

    if (streamerPool.length === 0) {
      console.warn('Live check skipped: streamer pool is empty.');
      liveStateInitialized = true;
      return;
    }

    refillShuffledStreamerQueueIfNeeded();

    const batch = shuffledStreamerQueue.splice(0, liveNotifierConfig.batchSize);
    let checkedCount = 0;
    let liveCount = 0;
    let notifiedCount = 0;
    let failedCount = 0;

    for (const streamer of batch) {
      try {
        const status = await fetchChzzkLiveStatus(streamer.chzzkChannelId);
        checkedCount += 1;

        const nowLive = status.isLive;
        const wasLive = liveStateByChannelId.get(streamer.chzzkChannelId) === true;

        if (nowLive) liveCount += 1;

        const shouldNotify =
          nowLive &&
          ((liveStateInitialized && !wasLive) ||
            (!liveStateInitialized && isBoot && liveNotifierConfig.notifyOnBoot));

        liveStateByChannelId.set(streamer.chzzkChannelId, nowLive);

        if (shouldNotify) {
          await alertChannel.send({
            content: `${streamer.name} 방송 ON`,
            allowedMentions: { parse: [] },
          });
          notifiedCount += 1;
          await sleep(300);
        }
      } catch (error) {
        failedCount += 1;
        console.warn(
          `Failed to check live status: ${streamer.name} (${streamer.chzzkChannelId}) - ${error.message}`,
        );
      }

      await sleep(150);
    }

    liveStateInitialized = true;

    console.log(
      [
        'Live check done.',
        `pool=${streamerPool.length}`,
        `queueLeft=${shuffledStreamerQueue.length}`,
        `batch=${batch.length}`,
        `checked=${checkedCount}`,
        `live=${liveCount}`,
        `notified=${notifiedCount}`,
        `failed=${failedCount}`,
      ].join(' '),
    );
  } finally {
    liveCheckRunning = false;
  }
}

async function refreshStreamerPoolIfNeeded({ force = false } = {}) {
  if (livePoolRefreshing) return;

  const now = Date.now();
  const shouldRefresh =
    force ||
    streamerPool.length === 0 ||
    now - lastLivePoolRefreshAt >= liveNotifierConfig.poolRefreshMs;

  if (!shouldRefresh) return;

  livePoolRefreshing = true;

  try {
    const items = await fetchVirtualStockItems();
    const parsed = [];
    let resolvedBySearch = 0;
    let directIdCount = 0;
    let resolveAttemptCount = 0;
    let resolveSkipCount = 0;

    for (const item of items) {
      const name = extractStreamerName(item);
      if (!name) continue;

      let chzzkChannelId = extractChzzkChannelId(item);

      if (chzzkChannelId) {
        directIdCount += 1;
      }

      if (!chzzkChannelId) {
        if (chzzkChannelIdByNameCache.has(name)) {
          chzzkChannelId = chzzkChannelIdByNameCache.get(name);
        } else if (chzzkResolveMissCache.has(name)) {
          resolveSkipCount += 1;
        } else if (resolveAttemptCount < liveNotifierConfig.chzzkResolveMaxPerRefresh) {
          resolveAttemptCount += 1;

          const resolved = await resolveChzzkChannelIdByName(name).catch((error) => {
            console.warn(`Failed to resolve CHZZK channel: ${name} - ${error.message}`);
            return '';
          });

          if (resolved) {
            chzzkChannelId = resolved;
            chzzkChannelIdByNameCache.set(name, resolved);
            resolvedBySearch += 1;
          } else {
            chzzkResolveMissCache.add(name);
          }

          await sleep(liveNotifierConfig.chzzkResolveDelayMs);
        }
      }

      if (!chzzkChannelId) continue;

      parsed.push({
        name,
        chzzkChannelId,
      });
    }

    const deduped = dedupeStreamersByChannelId(parsed);

    streamerPool = deduped;
    shuffledStreamerQueue = [];
    lastLivePoolRefreshAt = now;

    console.log(
      [
        'Live streamer pool refreshed.',
        `raw=${items.length}`,
        `parsed=${parsed.length}`,
        `deduped=${streamerPool.length}`,
        `directId=${directIdCount}`,
        `resolvedBySearch=${resolvedBySearch}`,
        `resolveAttempts=${resolveAttemptCount}`,
        `resolveSkipped=${resolveSkipCount}`,
        `cache=${chzzkChannelIdByNameCache.size}`,
        `miss=${chzzkResolveMissCache.size}`,
      ].join(' '),
    );

    if (items.length > 0 && parsed.length === 0) {
      console.log('Virtual-stock sample keys:', Object.keys(items[0] || {}).join(', '));
      console.log('Virtual-stock sample json:', JSON.stringify(items[0]).slice(0, 2000));
    }
  } finally {
    livePoolRefreshing = false;
  }
}

async function fetchVirtualStockItems() {
  const allItems = [];
  const seenKeys = new Set();

  for (let page = 1; page <= liveNotifierConfig.stockScanPages; page += 1) {
    const data = await fetchVirtualStockPage(page, liveNotifierConfig.stockPageSize);
    const rows = extractArrayFromVirtualStockResponse(data);

    if (rows.length === 0) {
      console.log(`Virtual-stock page ${page}: rows=0, stop.`);
      break;
    }

    let addedCount = 0;

    for (const row of rows) {
      const key =
        getFirstString(row, ['id', 'stockId', 'stock_id', 'symbol', 'code']) ||
        getNestedString(row, ['streamer', 'id']) ||
        getNestedString(row, ['channel', 'id']) ||
        getFirstString(row, ['channelName', 'name']) ||
        JSON.stringify(row).slice(0, 120);

      if (seenKeys.has(key)) continue;

      seenKeys.add(key);
      allItems.push(row);
      addedCount += 1;
    }

    console.log(
      `Virtual-stock page ${page}: rows=${rows.length}, added=${addedCount}, total=${allItems.length}`,
    );

    // page 파라미터가 무시돼서 같은 50개만 계속 오는 경우 무한 반복 방지
    if (addedCount === 0) {
      console.log(`Virtual-stock page ${page}: no new rows, stop.`);
      break;
    }

    await sleep(200);
  }

  return allItems;
}

async function fetchVirtualStockPage(page, pageSize) {
  const baseUrl = liveNotifierConfig.baseUrl.replace(/\/+$/, '');
  const offset = (page - 1) * pageSize;

  const urls = [
    `${baseUrl}/api/stocks?page=${page}&limit=${pageSize}&sort=change_rate&order=desc`,
    `${baseUrl}/api/stocks?page=${page}&size=${pageSize}&sort=change_rate&order=desc`,
    `${baseUrl}/api/stocks?page=${page}&pageSize=${pageSize}&sort=change_rate&order=desc`,
    `${baseUrl}/api/stocks?offset=${offset}&limit=${pageSize}&sort=change_rate&order=desc`,
    `${baseUrl}/api/stocks?skip=${offset}&take=${pageSize}&sort=change_rate&order=desc`,
    `${baseUrl}/api/stocks?sort=change_rate&order=desc&page=${page}&limit=${pageSize}`,
  ];

  if (page === 1) {
    urls.push(`${baseUrl}/api/stocks?sort=change_rate&order=desc`);
  }

  let bestData = null;
  let bestRows = [];
  let lastError = null;

  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const rows = extractArrayFromVirtualStockResponse(data);

      if (rows.length > bestRows.length) {
        bestData = data;
        bestRows = rows;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (bestData) return bestData;

  throw lastError || new Error('Failed to fetch virtual-stock stocks');
}

function extractArrayFromVirtualStockResponse(data) {
  if (Array.isArray(data)) return data;

  const candidates = [
    data,
    data?.data,
    data?.content,
    data?.result,
    data?.payload,
    data?.data?.data,
    data?.data?.content,
    data?.content?.data,
    data?.result?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;

    if (candidate && typeof candidate === 'object') {
      for (const key of ['stocks', 'items', 'rows', 'results', 'list', 'data', 'content']) {
        if (Array.isArray(candidate[key])) return candidate[key];
      }
    }
  }

  return [];
}

function normalizeVirtualStockStreamer(item) {
  const name = extractStreamerName(item);
  const chzzkChannelId = extractChzzkChannelId(item);

  if (!name || !chzzkChannelId) return null;

  return {
    name,
    chzzkChannelId,
  };
}

async function fetchVirtualStockDetailFromListItem(item) {
  const stockId = extractStockId(item);

  if (!stockId) {
    throw new Error('stock id not found in list item');
  }

  const baseUrl = liveNotifierConfig.baseUrl.replace(/\/+$/, '');

  const urls = [
    `${baseUrl}/api/stocks/${encodeURIComponent(stockId)}`,
    `${baseUrl}/api/stocks/detail/${encodeURIComponent(stockId)}`,
    `${baseUrl}/api/stocks?id=${encodeURIComponent(stockId)}`,
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`failed to fetch stock detail: ${stockId}`);
}

function extractStockId(item) {
  return (
    getFirstString(item, ['id', 'stockId', 'stock_id', 'symbol', 'code']) ||
    getNestedString(item, ['stock', 'id']) ||
    getNestedString(item, ['stock', 'stockId']) ||
    getNestedString(item, ['detail', 'id']) ||
    getNestedString(item, ['detail', 'stockId']) ||
    ''
  );
}

function extractStreamerName(item) {
  return (
    getFirstString(item, [
      'channelName',
      'name',
      'stockName',
      'displayName',
      'streamerName',
      'nickname',
      'title',
    ]) ||
    getNestedString(item, ['stock', 'channelName']) ||
    getNestedString(item, ['stock', 'name']) ||
    getNestedString(item, ['stock', 'stockName']) ||
    getNestedString(item, ['streamer', 'channelName']) ||
    getNestedString(item, ['streamer', 'name']) ||
    getNestedString(item, ['streamer', 'nickname']) ||
    getNestedString(item, ['channel', 'channelName']) ||
    getNestedString(item, ['creator', 'name']) ||
    getNestedString(item, ['detail', 'channelName']) ||
    getNestedString(item, ['detail', 'name']) ||
    getNestedString(item, ['detail', 'stockName']) ||
    getNestedString(item, ['detail', 'streamerName']) ||
    getNestedString(item, ['detail', 'streamer', 'channelName']) ||
    getNestedString(item, ['detail', 'streamer', 'name']) ||
    getNestedString(item, ['detail', 'channel', 'channelName']) ||
    ''
  );
}

async function resolveChzzkChannelIdByName(name) {
  const keyword = String(name || '').trim();
  if (!keyword) return '';

  const url =
    `https://api.chzzk.naver.com/service/v1/search/channels` +
    `?keyword=${encodeURIComponent(keyword)}` +
    `&offset=0` +
    `&size=5` +
    `&withFirstChannelContent=false`;

  const data = await fetchJson(url);
  const candidates = extractChzzkSearchChannelCandidates(data);

  if (candidates.length === 0) return '';

  const normalizedKeyword = normalizeSearchName(keyword);

  const exact = candidates.find((candidate) => {
    return normalizeSearchName(candidate.channelName) === normalizedKeyword;
  });

  if (exact) {
    console.log(`Resolved CHZZK exact: ${name} -> ${exact.channelName} (${exact.channelId})`);
    return exact.channelId;
  }

  if (liveNotifierConfig.chzzkSearchRequireExact) {
    console.log(
      `CHZZK resolve miss exact-only: ${name}, candidates=${candidates
        .map((candidate) => candidate.channelName)
        .join(' / ')}`,
    );
    return '';
  }

  const first = candidates[0];

  console.log(
    `Resolved CHZZK first: ${name} -> ${first.channelName} (${first.channelId})`,
  );

  return first.channelId;
}

function extractChzzkSearchChannelCandidates(data) {
  const content = data?.content ?? data;
  const rows =
    content?.data ||
    content?.channels ||
    content?.results ||
    data?.data ||
    [];

  if (!Array.isArray(rows)) return [];

  const candidates = [];

  for (const row of rows) {
    const channelObject = row?.channel || row;

    const channelId =
      getFirstString(channelObject, ['channelId', 'chzzkChannelId']) ||
      getNestedString(row, ['channel', 'channelId']) ||
      findChzzkChannelIdDeep(row);

    const channelName =
      getFirstString(channelObject, ['channelName', 'name']) ||
      getNestedString(row, ['channel', 'channelName']);

    if (!channelId || !channelName) continue;

    candidates.push({
      channelId,
      channelName,
    });
  }

  return candidates;
}

function normalizeSearchName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function extractChzzkChannelId(item) {
  const direct =
    getFirstString(item, [
      'chzzkChannelId',
      'channelId',
      'streamerChannelId',
      'chzzkId',
      'chzzk_channel_id',
      'chzzkChannelUID',
      'channelUid',
      'channelUID',
    ]) ||
    getNestedString(item, ['stock', 'chzzkChannelId']) ||
    getNestedString(item, ['stock', 'channelId']) ||
    getNestedString(item, ['streamer', 'chzzkChannelId']) ||
    getNestedString(item, ['streamer', 'channelId']) ||
    getNestedString(item, ['streamer', 'chzzkId']) ||
    getNestedString(item, ['channel', 'channelId']) ||
    getNestedString(item, ['channel', 'chzzkChannelId']) ||
    getNestedString(item, ['detail', 'chzzkChannelId']) ||
    getNestedString(item, ['detail', 'channelId']) ||
    getNestedString(item, ['detail', 'streamerChannelId']) ||
    getNestedString(item, ['detail', 'streamer', 'chzzkChannelId']) ||
    getNestedString(item, ['detail', 'streamer', 'channelId']) ||
    getNestedString(item, ['detail', 'channel', 'channelId']) ||
    getNestedString(item, ['detail', 'channel', 'chzzkChannelId']);

  if (direct && looksLikeChzzkChannelId(direct)) {
    return direct;
  }

  return findChzzkChannelIdDeep(item);
}

function findChzzkChannelIdDeep(value, depth = 0) {
  if (depth > 8 || value == null) return '';

  if (typeof value === 'string') {
    const fromUrl = extractChzzkChannelIdFromText(value);
    if (fromUrl) return fromUrl;

    if (looksLikeChzzkChannelId(value)) return value.trim();

    return '';
  }

  if (typeof value !== 'object') return '';

  for (const [key, child] of Object.entries(value)) {
    const keyLower = key.toLowerCase();

    if (
      typeof child === 'string' &&
      (keyLower.includes('chzzk') ||
        keyLower.includes('channel') ||
        keyLower.includes('streamer'))
    ) {
      const fromText = extractChzzkChannelIdFromText(child);
      if (fromText) return fromText;

      if (looksLikeChzzkChannelId(child)) return child.trim();
    }
  }

  for (const child of Object.values(value)) {
    const found = findChzzkChannelIdDeep(child, depth + 1);
    if (found) return found;
  }

  return '';
}

function extractChzzkChannelIdFromText(text) {
  if (typeof text !== 'string') return '';

  const match = text.match(/chzzk\.naver\.com\/(?:live\/)?([a-zA-Z0-9_-]{12,40})/);
  if (match) return match[1];

  return '';
}

function looksLikeChzzkChannelId(value) {
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();

  if (!/^[a-zA-Z0-9_-]{12,40}$/.test(trimmed)) return false;
  if (/^\d+$/.test(trimmed)) return false;

  return true;
}

function dedupeStreamersByChannelId(streamers) {
  const map = new Map();

  for (const streamer of streamers) {
    if (!streamer.chzzkChannelId) continue;

    const key = String(streamer.chzzkChannelId);
    if (!map.has(key)) {
      map.set(key, {
        name: streamer.name,
        chzzkChannelId: key,
      });
    }
  }

  return [...map.values()];
}

function refillShuffledStreamerQueueIfNeeded() {
  if (shuffledStreamerQueue.length > 0) return;

  shuffledStreamerQueue = shuffleArray([...streamerPool]);

  console.log(`Live streamer queue refilled. size=${shuffledStreamerQueue.length}`);
}

function shuffleArray(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }

  return items;
}

async function fetchChzzkLiveStatus(channelId) {
  const urls = [
    `https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`,
    `https://api.chzzk.naver.com/polling/v1/channels/${encodeURIComponent(channelId)}/live-status`,
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const content = data?.content ?? data;

      const statusText = String(content?.status || '').trim().toUpperCase();
      const liveTitle = typeof content?.liveTitle === 'string' ? content.liveTitle : '';
      const chatChannelId = typeof content?.chatChannelId === 'string' ? content.chatChannelId : '';

      const isLive =
        ['OPEN', 'LIVE', 'ON', 'ONAIR', 'ON_AIR', 'STREAMING'].includes(statusText) ||
        Boolean(liveTitle) ||
        Boolean(chatChannelId);

      return {
        isLive,
        status: statusText,
        liveTitle,
        chatChannelId,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Failed to fetch CHZZK live status: ${channelId}`);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'Mozilla/5.0 nyannyan-problem-bot/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseBoolean(value) {
  const parsed = parseBooleanLike(value);
  return parsed === true;
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'y', 'on', 'live'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off', 'offline'].includes(normalized)) return false;
  }

  return null;
}

function getFirstString(object, keys) {
  if (!object || typeof object !== 'object') return '';

  for (const key of keys) {
    const value = object[key];

    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  return '';
}

function getNestedString(object, path) {
  let current = object;

  for (const key of path) {
    if (!current || typeof current !== 'object') return '';
    current = current[key];
  }

  if (typeof current === 'string' && current.trim()) return current.trim();
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);

  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
