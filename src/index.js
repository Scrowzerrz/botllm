require('dotenv').config();
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Collection,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  REST,
  Routes,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { commands, attachmentOptionNames } = require('./commands');
const {
  getGlobalConfig,
  getGuildConfig,
  getEffectiveGuildSettings,
  updateGlobalConfig,
  setGlobalChatEnabled,
  setDefaultMaxAttachmentBytes,
  setEnforceDefaultMaxAttachment,
  setGuildChatEnabled,
  setGuildMaxAttachmentBytes,
  clearGuildMaxAttachment,
  addApiKey,
  removeApiKeyAt,
  MIN_ATTACHMENT_SIZE_MB,
  MAX_ATTACHMENT_SIZE_MB,
} = require('./config-store');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_OWNER_ID = process.env.DISCORD_OWNER_ID ? process.env.DISCORD_OWNER_ID.trim() : '';

if (!DISCORD_TOKEN) {
  console.error('Configure a variavel de ambiente DISCORD_TOKEN antes de iniciar.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const CONFIG_PANEL_PREFIX = 'config_panel:';
const CONFIG_BUTTON_IDS = {
  toggleGlobalChat: `${CONFIG_PANEL_PREFIX}toggle_global_chat`,
  setRateLimit: `${CONFIG_PANEL_PREFIX}set_rate`,
  setDefaultMaxAttachment: `${CONFIG_PANEL_PREFIX}set_default_attachment`,
  toggleAttachmentLock: `${CONFIG_PANEL_PREFIX}toggle_attachment_lock`,
  addApiKey: `${CONFIG_PANEL_PREFIX}add_key`,
  removeApiKey: `${CONFIG_PANEL_PREFIX}remove_key`,
  toggleGuildChat: `${CONFIG_PANEL_PREFIX}toggle_guild_chat`,
  setGuildMaxAttachment: `${CONFIG_PANEL_PREFIX}set_guild_max_attachment`,
  clearGuildMaxAttachment: `${CONFIG_PANEL_PREFIX}clear_guild_max_attachment`,
};

const CONFIG_MODAL_IDS = {
  setRateLimit: `${CONFIG_PANEL_PREFIX}set_rate_modal`,
  setDefaultMaxAttachment: `${CONFIG_PANEL_PREFIX}set_default_attachment_modal`,
  setGuildMaxAttachment: `${CONFIG_PANEL_PREFIX}set_guild_max_attachment_modal`,
  addApiKey: `${CONFIG_PANEL_PREFIX}add_key_modal`,
  removeApiKey: `${CONFIG_PANEL_PREFIX}remove_key_modal`,
};

const CONFIG_TEXT_INPUT_IDS = {
  rateSeconds: `${CONFIG_PANEL_PREFIX}rate_seconds`,
  defaultMaxAttachmentMb: `${CONFIG_PANEL_PREFIX}default_max_attachment_mb`,
  guildMaxAttachmentMb: `${CONFIG_PANEL_PREFIX}guild_max_attachment_mb`,
  apiKeyValue: `${CONFIG_PANEL_PREFIX}api_key_value`,
  removeKeyIndex: `${CONFIG_PANEL_PREFIX}remove_key_index`,
};

const MIN_RATE_LIMIT_SECONDS = 1;
const MAX_RATE_LIMIT_SECONDS = 3600;

const modelCache = new Map();
let apiKeyCursor = 0;
const configPanelMessages = new Map();

// Armazena o historico de conversa por canal/dm para manter contexto curto.
const conversationHistories = new Map();
const MAX_TURNS = 10;
const cooldowns = new Collection();

const RESPONSE_EMBED_COLOR = 0x5865f2;

function isBotOwner(userId) {
  return Boolean(DISCORD_OWNER_ID && userId && userId === DISCORD_OWNER_ID);
}

function truncateForDiscord(text, maxLength) {
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return '.'.repeat(maxLength);
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function buildChatResponseEmbed({ interaction, prompt, replyText, useGrounding, attachments }) {
  const embed = new EmbedBuilder()
    .setColor(RESPONSE_EMBED_COLOR)
    .setDescription(`Gemini responde:\n${truncateForDiscord(replyText, 4000)}`)
    .setFooter({
      text: useGrounding ? 'Gemini 2.5 Pro · Pesquisa web ativada' : 'Gemini 2.5 Pro',
    })
    .setTimestamp(new Date());

  const userDisplayName = interaction.user?.globalName || interaction.user?.username || 'Usuario';

  try {
    const avatarUrl =
      typeof interaction.user?.displayAvatarURL === 'function'
        ? interaction.user.displayAvatarURL({ size: 128 })
        : null;

    if (avatarUrl) {
      embed.setAuthor({ name: `${userDisplayName} perguntou`, iconURL: avatarUrl });
    } else {
      embed.setAuthor({ name: `${userDisplayName} perguntou` });
    }
  } catch {
    embed.setAuthor({ name: `${userDisplayName} perguntou` });
  }

  if (prompt) {
    embed.addFields({
      name: 'Mensagem',
      value: truncateForDiscord(prompt, 1024),
    });
  }

  if (attachments.length) {
    const attachmentLines = attachments.slice(0, 3).map(file => `• ${file.name}`);
    const attachmentSummary =
      attachments.length > 3
        ? `${attachmentLines.join('\n')}\n... e mais ${attachments.length - 3}`
        : attachmentLines.join('\n');

    embed.addFields({
      name: attachments.length === 1 ? 'Anexo' : 'Anexos',
      value: truncateForDiscord(attachmentSummary, 1024),
      inline: true,
    });

    const firstImage = attachments.find(file => {
      const mimeType = inferMimeType(file.name, file.contentType);
      return typeof mimeType === 'string' && mimeType.startsWith('image/');
    });

    if (firstImage) {
      embed.setImage(firstImage.url);
    }
  }

  if (useGrounding) {
    embed.addFields({
      name: 'Modo',
      value: 'Pesquisa na web ativada',
      inline: true,
    });
  }

  return embed;
}

function getInteractionContext(interaction) {
  const userId = interaction.user?.id || '';
  const guildId = interaction.guildId || null;
  const memberPermissions = interaction.memberPermissions;
  const hasAdminPermission = Boolean(memberPermissions?.has(PermissionFlagsBits.Administrator));
  const owner = isBotOwner(userId);

  return {
    userId,
    guildId,
    hasAdminPermission,
    isOwner: owner,
    canManageGuild: Boolean(guildId && (hasAdminPermission || owner)),
  };
}

const MIME_TYPES_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const SUPPORTED_INLINE_PREFIXES = ['image/', 'application/pdf'];

function inferMimeType(filename, provided) {
  if (provided && SUPPORTED_INLINE_PREFIXES.some(prefix => provided.startsWith(prefix))) {
    return provided;
  }

  const ext = path.extname(filename || '').toLowerCase();
  const byExt = MIME_TYPES_BY_EXTENSION[ext];
  if (byExt) {
    return byExt;
  }

  if (provided) {
    return provided;
  }

  return 'application/octet-stream';
}

function isSupportedMime(mimeType) {
  return SUPPORTED_INLINE_PREFIXES.some(prefix => mimeType.startsWith(prefix));
}

function maskApiKey(apiKey) {
  if (!apiKey) {
    return '—';
  }

  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return `${'*'.repeat(Math.max(0, trimmed.length - 2))}${trimmed.slice(-2)}`;
  }

  const start = trimmed.slice(0, 4);
  const end = trimmed.slice(-4);
  return `${start}…${end}`;
}

function formatAttachmentMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function formatAttachmentMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function buildConfigEmbed(context) {
  const { globalConfig, guildConfig, effective, guildId } = context;

  const embed = new EmbedBuilder()
    .setTitle('Painel de configuracao do bot')
    .setColor(0x5865f2)
    .setDescription('Gerencie limites, chaves da API e recursos do bot.');

  embed.addFields(
    {
      name: 'Chat global',
      value: globalConfig.globalChatEnabled ? 'Ativo' : 'Desativado pelo dono',
      inline: true,
    },
    {
      name: 'Intervalo minimo (global)',
      value: `${(globalConfig.rateLimitMs / 1000).toFixed(1)} s`,
      inline: true,
    },
    {
      name: 'Limite padrao de anexos',
      value: `${formatAttachmentMb(globalConfig.defaultMaxAttachmentBytes)} MB${
        globalConfig.enforceDefaultMaxAttachment ? ' (bloqueado)' : ''
      }`,
      inline: true,
    },
  );

  if (guildId) {
    let guildChatStatus;
    if (!globalConfig.globalChatEnabled) {
      guildChatStatus = 'Desativado (global)';
    } else {
      guildChatStatus = guildConfig.chatEnabled ? 'Ativo neste servidor' : 'Desativado neste servidor';
    }

    embed.addFields({
      name: 'Chat neste servidor',
      value: guildChatStatus,
      inline: true,
    });

    let guildLimitValue;
    if (globalConfig.enforceDefaultMaxAttachment) {
      guildLimitValue = `${formatAttachmentMb(globalConfig.defaultMaxAttachmentBytes)} MB (bloqueado pelo dono)`;
    } else if (Number.isFinite(guildConfig.maxAttachmentBytes)) {
      guildLimitValue = `${formatAttachmentMb(guildConfig.maxAttachmentBytes)} MB (personalizado)`;
    } else {
      guildLimitValue = `${formatAttachmentMb(globalConfig.defaultMaxAttachmentBytes)} MB (padrao global)`;
    }

    embed.addFields({
      name: 'Limite de anexos neste servidor',
      value: guildLimitValue,
      inline: true,
    });
  }

  if (!globalConfig.apiKeys.length) {
    embed.addFields({
      name: 'API keys configuradas',
      value: 'Nenhuma API key cadastrada ainda.',
      inline: false,
    });
  } else {
    const formattedKeys = globalConfig.apiKeys
      .map((key, index) => `**${index + 1}.** ${maskApiKey(key)}`)
      .join('\n');

    embed.addFields({
      name: 'API keys configuradas',
      value: formattedKeys,
      inline: false,
    });
  }

  if (!globalConfig.globalChatEnabled) {
    embed.setFooter({ text: '/chat esta desativado globalmente pelo dono do bot.' });
  } else if (guildId && !effective.chatEnabled) {
    embed.setFooter({ text: '/chat esta desativado neste servidor.' });
  }

  return embed;
}

function buildConfigComponents(context) {
  const {
    globalConfig,
    guildConfig,
    guildId,
    isOwner,
    canManageGuild,
  } = context;

  const rows = [];

  if (isOwner) {
    const ownerRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.toggleGlobalChat)
        .setLabel(globalConfig.globalChatEnabled ? 'Desativar /chat global' : 'Ativar /chat global')
        .setStyle(globalConfig.globalChatEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.setRateLimit)
        .setLabel('Intervalo minimo')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.setDefaultMaxAttachment)
        .setLabel('Limite padrao de anexos')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.toggleAttachmentLock)
        .setLabel(
          globalConfig.enforceDefaultMaxAttachment
            ? 'Permitir limite por servidor'
            : 'Bloquear limite por servidor',
        )
        .setStyle(globalConfig.enforceDefaultMaxAttachment ? ButtonStyle.Success : ButtonStyle.Danger),
    );

    rows.push(ownerRow);

    const apiRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.addApiKey)
        .setLabel('Adicionar API key')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.removeApiKey)
        .setLabel('Remover API key')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(globalConfig.apiKeys.length === 0),
    );

    rows.push(apiRow);
  }

  if (guildId && canManageGuild) {
    const overrideExists = Number.isFinite(guildConfig.maxAttachmentBytes);

    const guildRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.toggleGuildChat)
        .setLabel(guildConfig.chatEnabled ? 'Desativar /chat neste servidor' : 'Ativar /chat neste servidor')
        .setStyle(guildConfig.chatEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.setGuildMaxAttachment)
        .setLabel('Limite de anexos deste servidor')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(globalConfig.enforceDefaultMaxAttachment),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.clearGuildMaxAttachment)
        .setLabel('Usar limite padrao')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(globalConfig.enforceDefaultMaxAttachment || !overrideExists),
    );

    rows.push(guildRow);
  }

  return rows;
}

function buildConfigPanelPayload(options = {}) {
  const requesterId = options.requesterId || '';
  const guildId = options.guildId || null;
  const isOwner = options.isOwner ?? isBotOwner(requesterId);
  const canManageGuild = options.canManageGuild ?? Boolean(guildId && isOwner);

  const { global: globalConfig, guild: guildConfig, effective } = getEffectiveGuildSettings(guildId);

  const payload = {
    embeds: [
      buildConfigEmbed({
        globalConfig,
        guildConfig,
        effective,
        guildId,
      }),
    ],
    components: buildConfigComponents({
      globalConfig,
      guildConfig,
      guildId,
      isOwner,
      canManageGuild,
    }),
  };

  if (Object.prototype.hasOwnProperty.call(options, 'content')) {
    payload.content = options.content;
  }

  return payload;
}


async function registerConfigPanelMessage(userId, message) {
  const previous = configPanelMessages.get(userId);
  configPanelMessages.set(userId, message);

  if (previous && previous.id !== message.id) {
    try {
      await previous.delete();
    } catch (error) {
      // Ignora falhas ao excluir mensagens efêmeras.
    }
  }
}

function rememberConfigPanelMessage(userId, message) {
  if (message) {
    configPanelMessages.set(userId, message);
  }
}

function ensureCursorWithinBounds(keysLength) {
  if (!Number.isInteger(keysLength) || keysLength <= 0) {
    apiKeyCursor = 0;
    return;
  }

  apiKeyCursor %= keysLength;
  if (apiKeyCursor < 0) {
    apiKeyCursor += keysLength;
  }
}

function syncApiKeyRotation() {
  const { apiKeys } = getGlobalConfig();
  ensureCursorWithinBounds(apiKeys.length);
}

function getModelForApiKey(apiKey) {
  if (modelCache.has(apiKey)) {
    return modelCache.get(apiKey);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const createdModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    modelCache.set(apiKey, createdModel);
    return createdModel;
  } catch (error) {
    modelCache.delete(apiKey);
    throw error;
  }
}

async function generateContentWithAvailableKeys(requestPayload, providedKeys) {
  const keysFromConfig = Array.isArray(providedKeys) ? providedKeys : getGlobalConfig().apiKeys;
  const apiKeys = Array.isArray(keysFromConfig) ? keysFromConfig.filter(Boolean) : [];

  if (apiKeys.length === 0) {
    throw new Error('Nenhuma API key configurada.');
  }

  ensureCursorWithinBounds(apiKeys.length);

  for (let attempt = 0; attempt < apiKeys.length; attempt += 1) {
    const index = (apiKeyCursor + attempt) % apiKeys.length;
    const apiKey = apiKeys[index];

    if (!apiKey) {
      continue;
    }

    try {
      const targetModel = getModelForApiKey(apiKey);
      const result = await targetModel.generateContent(requestPayload);
      apiKeyCursor = (index + 1) % apiKeys.length;
      return result;
    } catch (error) {
      console.error(`Erro ao usar a API key ${index + 1}:`, error);
      modelCache.delete(apiKey);
    }
  }

  throw new Error('Todas as API keys configuradas falharam.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, readyClient => {
  console.log(`Bot conectado como ${readyClient.user.tag}`);
  console.log(`Participando de ${client.guilds.cache.size} servidores.`);

  try {
    client.user.setPresence({
      status: 'online',
      activities: [{ name: 'com /chat', type: 0 }],
    });
  } catch (error) {
    console.warn('Nao foi possivel atualizar a presenca:', error);
  }
  if (!DISCORD_CLIENT_ID) {
    console.warn('Defina DISCORD_CLIENT_ID para registrar comandos de barra automaticamente.');
    return;
  }

  (async () => {
    try {
      if (DISCORD_GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
          body: commands,
        });
        console.log('Comandos de guild registrados.');
      } else {
        await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
        console.log('Comandos globais registrados (pode levar alguns minutos para aparecer).');
      }
    } catch (error) {
      console.error('Falha ao registrar comandos automaticamente:', error);
    }
  })();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'chat') {
        await handleChatCommand(interaction);
        return;
      }

      if (interaction.commandName === 'configurar') {
        await handleConfigureCommand(interaction);
      }

      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(CONFIG_PANEL_PREFIX)) {
      await handleConfigButtonInteraction(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(CONFIG_PANEL_PREFIX)) {
      await handleConfigModalInteraction(interaction);
    }
  } catch (error) {
    console.error('Erro ao processar interação:', error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: 'Ocorreu um erro ao processar esta interação.',
          ephemeral: true,
        });
      } catch (replyError) {
        console.error('Falha ao enviar resposta de erro para a interação:', replyError);
      }
    }
  }
});

async function handleChatCommand(interaction) {
  const { global: globalConfig, guild: guildConfig, effective } = getEffectiveGuildSettings(
    interaction.guildId,
  );
  const rateLimitMs = globalConfig.rateLimitMs;
  const maxAttachmentBytes = effective.maxAttachmentBytes;
  const availableKeys = Array.isArray(globalConfig.apiKeys)
    ? globalConfig.apiKeys.filter(Boolean)
    : [];

  if (!globalConfig.globalChatEnabled) {
    await interaction.reply({
      content: 'O comando /chat foi desativado globalmente pelo dono do bot.',
      ephemeral: true,
    });
    return;
  }

  if (!effective.chatEnabled) {
    await interaction.reply({
      content: 'O comando /chat foi desativado neste servidor.',
      ephemeral: true,
    });
    return;
  }

  if (!availableKeys.length) {
    await interaction.reply({
      content: 'Nenhuma API key do Gemini esta configurada. Adicione uma em /configurar para habilitar o chat.',
      ephemeral: true,
    });
    return;
  }

  const prompt = (interaction.options.getString('mensagem') || '').trim();
  const useGrounding = Boolean(interaction.options.getBoolean('pesquisa'));
  const attachments = attachmentOptionNames
    .map(name => interaction.options.getAttachment(name))
    .filter(Boolean);

  if (!prompt && attachments.length === 0) {
    await interaction.reply({
      content: 'Envie uma mensagem ou anexe um arquivo válido para conversar com o modelo.',
      ephemeral: true,
    });
    return;
  }

  for (const file of attachments) {
    const mimeType = inferMimeType(file.name, file.contentType);
    if (file.size && file.size > maxAttachmentBytes) {
      await interaction.reply({
        content: `O arquivo ${file.name} excede o limite de ${(maxAttachmentBytes / 1024 / 1024).toFixed(
          1
        )} MB.`,
        ephemeral: true,
      });
      return;
    }

    if (!isSupportedMime(mimeType)) {
      await interaction.reply({
        content: `O tipo de arquivo ${mimeType} não é suportado. Envie imagens ou PDFs.`,
        ephemeral: true,
      });
      return;
    }
  }

  const now = Date.now();
  const lastRequest = cooldowns.get(interaction.user.id) || 0;
  const elapsed = now - lastRequest;

  if (elapsed < rateLimitMs) {
    const waitSeconds = Math.ceil((rateLimitMs - elapsed) / 1000);
    await interaction.reply({
      content: `Aguarde ${waitSeconds}s antes de enviar outra mensagem.`,
      ephemeral: true,
    });
    return;
  }

  try {
    cooldowns.set(interaction.user.id, now);

    await interaction.deferReply();

    const historyKey = interaction.channelId
      ? `channel:${interaction.channelId}`
      : `dm:${interaction.user.id}`;
    const history = conversationHistories.get(historyKey) || [];

    const userParts = [];
    if (prompt) {
      userParts.push({ text: prompt });
    }

    for (const file of attachments) {
      const mimeType = inferMimeType(file.name, file.contentType);
      const downloadResponse = await fetch(file.url);
      if (!downloadResponse.ok) {
        throw new Error(`Falha ao baixar o arquivo ${file.name}: ${downloadResponse.statusText}`);
      }

      const arrayBuffer = await downloadResponse.arrayBuffer();
      if (arrayBuffer.byteLength > maxAttachmentBytes) {
        throw new Error(`O arquivo ${file.name} excede o limite permitido após o download.`);
      }

      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      userParts.push({
        inlineData: {
          data: base64Data,
          mimeType,
        },
      });
    }

    const userMessage = { role: 'user', parts: userParts };

    const requestPayload = {
      contents: [...history, userMessage],
    };

    if (useGrounding) {
      requestPayload.tools = [{ googleSearch: {} }];
    }

    const result = await generateContentWithAvailableKeys(requestPayload, availableKeys);
    const response = result?.response;
    let replyText = '';

    if (response) {
      replyText = (response.text() || '').trim();
    }

    if (!replyText) {
      replyText = 'Não consegui gerar uma resposta agora.';
    }

    const candidate = response?.candidates?.[0];
    const modelMessage =
      candidate?.content?.parts?.length
        ? {
            role: candidate.content.role || 'model',
            parts: candidate.content.parts,
          }
        : {
            role: 'model',
            parts: [{ text: replyText }],
          };

    const updatedHistory = [
      ...history,
      userMessage,
      modelMessage,
    ].slice(-MAX_TURNS * 2);

    conversationHistories.set(historyKey, updatedHistory);

    const responseEmbed = buildChatResponseEmbed({
      interaction,
      prompt,
      replyText,
      useGrounding,
      attachments,
    });

    await interaction.editReply({
      content: '',
      embeds: [responseEmbed],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    cooldowns.delete(interaction.user.id);
    const errorMessage = typeof error?.message === 'string' ? error.message : '';
    const fallbackReply = errorMessage.includes('API key')
      ? 'Não foi possível usar nenhuma das API keys configuradas. Verifique as configurações em /configurar.'
      : 'Desculpe, ocorreu um erro ao falar com o modelo. Tente novamente em instantes.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(fallbackReply);
      } else {
        await interaction.reply(fallbackReply);
      }
    } catch {
      // Ignora falhas ao responder erros.
    }
  }
}

async function handleConfigureCommand(interaction) {
  const context = getInteractionContext(interaction);
  const { userId, guildId, hasAdminPermission, isOwner, canManageGuild } = context;

  if (!hasAdminPermission && !isOwner) {
    const denialMessage = DISCORD_OWNER_ID
      ? 'Apenas administradores ou o dono do bot podem alterar as configuracoes do bot.'
      : 'Apenas administradores podem alterar as configuracoes do bot.';
    await interaction.reply({
      content: denialMessage,
      ephemeral: true,
    });
    return;
  }

  try {
    const payload = buildConfigPanelPayload({
      requesterId: userId,
      guildId,
      isOwner,
      canManageGuild,
      content: 'Use os botoes abaixo para ajustar as configuracoes do bot.',
    });

    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });

    await registerConfigPanelMessage(interaction.user.id, message);
  } catch (error) {
    console.error('Falha ao exibir painel de configuracao:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Nao foi possivel abrir o painel de configuracao. Tente novamente mais tarde.',
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: 'Nao foi possivel abrir o painel de configuracao. Tente novamente mais tarde.',
        ephemeral: true,
      });
    }
  }
}

async function handleConfigButtonInteraction(interaction) {
  const customId = interaction.customId;
  const context = getInteractionContext(interaction);
  const { userId, guildId, isOwner, canManageGuild } = context;

  const buildPayload = content =>
    buildConfigPanelPayload({
      requesterId: userId,
      guildId,
      isOwner,
      canManageGuild,
      content,
    });

  if (customId === CONFIG_BUTTON_IDS.toggleGlobalChat) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode alterar o estado global do /chat.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    const nextChatEnabled = !globalConfig.globalChatEnabled;
    setGlobalChatEnabled(nextChatEnabled);

    const payload = buildPayload(
      nextChatEnabled
        ? 'O comando /chat foi reativado globalmente.'
        : 'O comando /chat foi desativado globalmente. Nenhum servidor podera usa-lo ate ser reativado.'
    );

    await interaction.update(payload);
    rememberConfigPanelMessage(interaction.user.id, interaction.message);

    if (!nextChatEnabled) {
      cooldowns.clear();
    }

    return;
  }

  if (customId === CONFIG_BUTTON_IDS.setRateLimit) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode ajustar o intervalo minimo.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.setRateLimit)
      .setTitle('Intervalo minimo entre mensagens')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.rateSeconds)
            .setLabel(`Intervalo em segundos (${MIN_RATE_LIMIT_SECONDS}-${MAX_RATE_LIMIT_SECONDS})`)
            .setPlaceholder('Ex: 10')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(Math.max(MIN_RATE_LIMIT_SECONDS, Math.round(globalConfig.rateLimitMs / 1000)).toString()),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.setDefaultMaxAttachment) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode definir o limite padrao de anexos.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.setDefaultMaxAttachment)
      .setTitle('Limite padrao de anexos (MB)')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.defaultMaxAttachmentMb)
            .setLabel(`Tamanho em MB (${MIN_ATTACHMENT_SIZE_MB}-${MAX_ATTACHMENT_SIZE_MB})`)
            .setPlaceholder('Ex: 8')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(formatAttachmentMb(globalConfig.defaultMaxAttachmentBytes)),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.toggleAttachmentLock) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode bloquear ou liberar o limite padrao de anexos.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    const nextLocked = !globalConfig.enforceDefaultMaxAttachment;
    setEnforceDefaultMaxAttachment(nextLocked);

    const payload = buildPayload(
      nextLocked
        ? 'O limite padrao de anexos foi bloqueado para todos os servidores.'
        : 'Os servidores agora podem definir limites de anexos personalizados novamente.'
    );

    await interaction.update(payload);
    rememberConfigPanelMessage(interaction.user.id, interaction.message);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.addApiKey) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode adicionar chaves da API do modelo.',
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.addApiKey)
      .setTitle('Adicionar nova API key do Gemini')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.apiKeyValue)
            .setLabel('Cole a API key do Gemini (Google AI Studio)')
            .setPlaceholder('Ex: AIzaSy...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.removeApiKey) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode remover chaves da API do modelo.',
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.removeApiKey)
      .setTitle('Remover API key do Gemini')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.removeKeyIndex)
            .setLabel('Numero da API key para remover (ex: 1)')
            .setPlaceholder('Informe o numero exibido no painel')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (!guildId) {
    await interaction.reply({
      content: 'Esta acao so pode ser usada dentro de um servidor.',
      ephemeral: true,
    });
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.toggleGuildChat) {
    if (!canManageGuild) {
      await interaction.reply({
        content: 'Apenas administradores deste servidor ou o dono do bot podem alterar o /chat aqui.',
        ephemeral: true,
      });
      return;
    }

    const guildConfig = getGuildConfig(guildId);
    const nextGuildChatEnabled = !guildConfig.chatEnabled;
    setGuildChatEnabled(guildId, nextGuildChatEnabled);

    const globalConfig = getGlobalConfig();
    let message;
    if (nextGuildChatEnabled) {
      message = globalConfig.globalChatEnabled
        ? 'O comando /chat foi ativado neste servidor.'
        : 'O comando /chat foi ativado neste servidor, mas permanece indisponivel enquanto estiver desativado globalmente.';
    } else {
      message = 'O comando /chat foi desativado neste servidor.';
    }

    const payload = buildPayload(message);
    await interaction.update(payload);
    rememberConfigPanelMessage(interaction.user.id, interaction.message);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.setGuildMaxAttachment) {
    if (!canManageGuild) {
      await interaction.reply({
        content: 'Apenas administradores deste servidor ou o dono do bot podem alterar o limite de anexos.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    if (globalConfig.enforceDefaultMaxAttachment) {
      await interaction.reply({
        content: 'O dono do bot bloqueou a edicao do limite de anexos.',
        ephemeral: true,
      });
      return;
    }

    const guildConfig = getGuildConfig(guildId);
    const initialValue = Number.isFinite(guildConfig.maxAttachmentBytes)
      ? formatAttachmentMb(guildConfig.maxAttachmentBytes)
      : formatAttachmentMb(globalConfig.defaultMaxAttachmentBytes);

    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.setGuildMaxAttachment)
      .setTitle('Limite de anexos deste servidor (MB)')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.guildMaxAttachmentMb)
            .setLabel(`Tamanho em MB (${MIN_ATTACHMENT_SIZE_MB}-${MAX_ATTACHMENT_SIZE_MB})`)
            .setPlaceholder('Ex: 8')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(initialValue),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.clearGuildMaxAttachment) {
    if (!canManageGuild) {
      await interaction.reply({
        content: 'Apenas administradores deste servidor ou o dono do bot podem alterar o limite de anexos.',
        ephemeral: true,
      });
      return;
    }

    clearGuildMaxAttachment(guildId);
    const payload = buildPayload('Limite de anexos deste servidor voltou ao padrao global.');
    await interaction.update(payload);
    rememberConfigPanelMessage(interaction.user.id, interaction.message);
    return;
  }
}


async function handleConfigModalInteraction(interaction) {
  const { customId } = interaction;
  const context = getInteractionContext(interaction);
  const { userId, guildId, isOwner, canManageGuild } = context;

  const buildPayload = content =>
    buildConfigPanelPayload({
      requesterId: userId,
      guildId,
      isOwner,
      canManageGuild,
      content,
    });

  if (customId === CONFIG_MODAL_IDS.setRateLimit) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode ajustar o intervalo minimo.',
        ephemeral: true,
      });
      return;
    }

    const rawValue = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.rateSeconds)
      .trim()
      .replace(',', '.');
    const seconds = Number(rawValue);

    if (!Number.isFinite(seconds)) {
      const payload = buildPayload('Informe um numero valido para o intervalo minimo (em segundos).');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    if (seconds < MIN_RATE_LIMIT_SECONDS || seconds > MAX_RATE_LIMIT_SECONDS) {
      const payload = buildPayload(`O intervalo deve estar entre ${MIN_RATE_LIMIT_SECONDS}s e ${MAX_RATE_LIMIT_SECONDS}s.`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const rateLimitMs = Math.round(seconds * 1000);
    const globalConfig = getGlobalConfig();

    if (rateLimitMs === globalConfig.rateLimitMs) {
      const payload = buildPayload('O intervalo informado ja esta configurado.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    updateGlobalConfig({ rateLimitMs });
    cooldowns.clear();

    const payload = buildPayload(`Intervalo minimo atualizado para ${(rateLimitMs / 1000).toFixed(1)}s.`);
    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });
    await registerConfigPanelMessage(interaction.user.id, message);
    return;
  }

  if (customId === CONFIG_MODAL_IDS.setDefaultMaxAttachment) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode definir o limite padrao de anexos.',
        ephemeral: true,
      });
      return;
    }

    const rawValue = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.defaultMaxAttachmentMb)
      .trim()
      .replace(',', '.');
    const megabytes = Number(rawValue);

    if (!Number.isFinite(megabytes)) {
      const payload = buildPayload('Informe um numero valido para o limite padrao (em MB).');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    if (megabytes < MIN_ATTACHMENT_SIZE_MB || megabytes > MAX_ATTACHMENT_SIZE_MB) {
      const payload = buildPayload(`O tamanho deve estar entre ${MIN_ATTACHMENT_SIZE_MB} MB e ${MAX_ATTACHMENT_SIZE_MB} MB.`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const maxAttachmentBytes = Math.round(megabytes * 1024 * 1024);
    const globalConfig = getGlobalConfig();

    if (maxAttachmentBytes === globalConfig.defaultMaxAttachmentBytes) {
      const payload = buildPayload('O limite informado ja esta configurado.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    setDefaultMaxAttachmentBytes(maxAttachmentBytes);

    const payload = buildPayload(
      `Limite padrao de anexos atualizado para ${(maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB.`
    );
    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });
    await registerConfigPanelMessage(interaction.user.id, message);
    return;
  }

  if (customId === CONFIG_MODAL_IDS.setGuildMaxAttachment) {
    if (!guildId || !canManageGuild) {
      await interaction.reply({
        content: 'Apenas administradores deste servidor ou o dono do bot podem alterar o limite de anexos.',
        ephemeral: true,
      });
      return;
    }

    const globalConfig = getGlobalConfig();
    if (globalConfig.enforceDefaultMaxAttachment) {
      await interaction.reply({
        content: 'O dono do bot bloqueou a edicao do limite de anexos.',
        ephemeral: true,
      });
      return;
    }

    const rawValue = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.guildMaxAttachmentMb)
      .trim()
      .replace(',', '.');
    const megabytes = Number(rawValue);

    if (!Number.isFinite(megabytes)) {
      const payload = buildPayload('Informe um numero valido para o limite de anexos (em MB).');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    if (megabytes < MIN_ATTACHMENT_SIZE_MB || megabytes > MAX_ATTACHMENT_SIZE_MB) {
      const payload = buildPayload(`O tamanho deve estar entre ${MIN_ATTACHMENT_SIZE_MB} MB e ${MAX_ATTACHMENT_SIZE_MB} MB.`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const maxAttachmentBytes = Math.round(megabytes * 1024 * 1024);
    const currentConfig = getGuildConfig(guildId);

    if (Number.isFinite(currentConfig.maxAttachmentBytes) && currentConfig.maxAttachmentBytes === maxAttachmentBytes) {
      const payload = buildPayload('O limite informado ja esta configurado para este servidor.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    setGuildMaxAttachmentBytes(guildId, maxAttachmentBytes);

    const payload = buildPayload(
      `Limite de anexos deste servidor atualizado para ${(maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB.`
    );
    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });
    await registerConfigPanelMessage(interaction.user.id, message);
    return;
  }

  if (customId === CONFIG_MODAL_IDS.addApiKey) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode adicionar chaves da API do modelo.',
        ephemeral: true,
      });
      return;
    }

    const apiKey = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.apiKeyValue)
      .trim();

    if (!apiKey) {
      const payload = buildPayload('Informe uma API key valida para adiciona-la.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    try {
      addApiKey(apiKey);
      syncApiKeyRotation();

      const payload = buildPayload('API key adicionada com sucesso.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    } catch (error) {
      console.error('Falha ao adicionar API key:', error);
      const payload = buildPayload(`Nao foi possivel adicionar a API key: ${error.message || 'erro desconhecido.'}`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    }

    return;
  }

  if (customId === CONFIG_MODAL_IDS.removeApiKey) {
    if (!isOwner) {
      await interaction.reply({
        content: 'Somente o dono do bot pode remover chaves da API do modelo.',
        ephemeral: true,
      });
      return;
    }

    const rawIndex = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.removeKeyIndex)
      .trim();
    const parsedIndex = Number.parseInt(rawIndex, 10);

    if (!Number.isInteger(parsedIndex) || parsedIndex < 1) {
      const payload = buildPayload('Informe o numero da API key exatamente como exibido no painel.');
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    try {
      const removalResult = removeApiKeyAt(parsedIndex - 1);
      if (removalResult?.removedApiKey) {
        modelCache.delete(removalResult.removedApiKey);
      }
      syncApiKeyRotation();

      const payload = buildPayload(`API key numero ${parsedIndex} removida com sucesso.`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    } catch (error) {
      console.error('Falha ao remover API key:', error);
      const payload = buildPayload(`Nao foi possivel remover a API key: ${error.message || 'erro desconhecido.'}`);
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    }
  }
}

client.on(Events.Error, error => {
  console.error('Erro do cliente Discord:', error);
});

client.on(Events.ShardError, error => {
  console.error('Erro de shard do Discord:', error);
});

process.on('unhandledRejection', reason => {
  console.error('Promise rejeitada sem tratamento:', reason);
});

process.on('uncaughtException', error => {
  console.error('Excecao nao tratada:', error);
});

client.login(DISCORD_TOKEN).catch(error => {
  console.error('Falha ao conectar no Discord:', error);
  process.exit(1);
});
