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
const { getConfig, updateConfig, addApiKey, removeApiKeyAt } = require('./config-store');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error('Configure a variavel de ambiente DISCORD_TOKEN antes de iniciar.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const CONFIG_PANEL_PREFIX = 'config_panel:';
const CONFIG_BUTTON_IDS = {
  toggleChat: `${CONFIG_PANEL_PREFIX}toggle_chat`,
  setRateLimit: `${CONFIG_PANEL_PREFIX}set_rate`,
  setMaxAttachment: `${CONFIG_PANEL_PREFIX}set_max_attachment`,
  addApiKey: `${CONFIG_PANEL_PREFIX}add_key`,
  removeApiKey: `${CONFIG_PANEL_PREFIX}remove_key`,
};

const CONFIG_MODAL_IDS = {
  setRateLimit: `${CONFIG_PANEL_PREFIX}set_rate_modal`,
  setMaxAttachment: `${CONFIG_PANEL_PREFIX}set_max_attachment_modal`,
  addApiKey: `${CONFIG_PANEL_PREFIX}add_key_modal`,
  removeApiKey: `${CONFIG_PANEL_PREFIX}remove_key_modal`,
};

const CONFIG_TEXT_INPUT_IDS = {
  rateSeconds: `${CONFIG_PANEL_PREFIX}rate_seconds`,
  maxAttachmentMb: `${CONFIG_PANEL_PREFIX}max_attachment_mb`,
  apiKeyValue: `${CONFIG_PANEL_PREFIX}api_key_value`,
  removeKeyIndex: `${CONFIG_PANEL_PREFIX}remove_key_index`,
};

const MIN_RATE_LIMIT_SECONDS = 1;
const MAX_RATE_LIMIT_SECONDS = 3600;
const MIN_ATTACHMENT_SIZE_MB = 1;
const MAX_ATTACHMENT_SIZE_MB = 100;

const modelCache = new Map();
let apiKeyCursor = 0;
const configPanelMessages = new Map();

// Armazena o historico de conversa por canal/dm para manter contexto curto.
const conversationHistories = new Map();
const MAX_TURNS = 10;
const cooldowns = new Collection();

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

function buildConfigEmbed(config) {
  const embed = new EmbedBuilder()
    .setTitle('Painel de configuração do bot')
    .setColor(0x5865f2)
    .setDescription('Gerencie limites, chaves da API e recursos do bot.');

  embed.addFields(
    {
      name: 'Chat habilitado',
      value: config.chatEnabled ? '✅ Sim' : '🚫 Não',
      inline: true,
    },
    {
      name: 'Intervalo mínimo',
      value: `${(config.rateLimitMs / 1000).toFixed(1)} s`,
      inline: true,
    },
    {
      name: 'Tamanho máximo dos anexos',
      value: `${(config.maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB`,
      inline: true,
    },
  );

  if (!config.apiKeys.length) {
    embed.addFields({
      name: 'API keys configuradas',
      value: 'Nenhuma API key cadastrada ainda.',
      inline: false,
    });
  } else {
    const formattedKeys = config.apiKeys
      .map((key, index) => `**${index + 1}.** ${maskApiKey(key)}`)
      .join('\n');

    embed.addFields({
      name: 'API keys configuradas',
      value: formattedKeys,
      inline: false,
    });
  }

  return embed;
}

function buildConfigComponents(config) {
  const rows = [];

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.toggleChat)
        .setLabel(config.chatEnabled ? 'Desativar /chat' : 'Ativar /chat')
        .setStyle(config.chatEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.setRateLimit)
        .setLabel('Intervalo mínimo')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.setMaxAttachment)
        .setLabel('Tamanho máximo')
        .setStyle(ButtonStyle.Primary),
    ),
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.addApiKey)
        .setLabel('Adicionar API key')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(CONFIG_BUTTON_IDS.removeApiKey)
        .setLabel('Remover API key')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(config.apiKeys.length === 0),
    ),
  );

  return rows;
}

function buildConfigPanelPayload(options = {}) {
  const config = getConfig();
  const payload = {
    embeds: [buildConfigEmbed(config)],
    components: buildConfigComponents(config),
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
  const { apiKeys } = getConfig();
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
  const keysFromConfig = Array.isArray(providedKeys) ? providedKeys : getConfig().apiKeys;
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
  const config = getConfig();
  const { rateLimitMs, maxAttachmentBytes, chatEnabled, apiKeys } = config;

  if (!chatEnabled) {
    await interaction.reply({
      content: 'O comando /chat foi desativado pelo dono do bot.',
      ephemeral: true,
    });
    return;
  }

  const availableKeys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [];

  if (!availableKeys.length) {
    await interaction.reply({
      content:
        'Nenhuma API key do Gemini está configurada. Adicione uma em /configurar para habilitar o chat.',
      ephemeral: true,
    });
    return;
  }

  const prompt = (interaction.options.getString('mensagem') || '').trim();
  const pesquisaWeb = interaction.options.getString('pesquisa_web');
  const useGrounding = pesquisaWeb === 'ativar';
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

    await interaction.editReply(replyText.slice(0, 1900));
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
  const memberPermissions = interaction.memberPermissions;
  const hasAdminPermission = memberPermissions?.has(PermissionFlagsBits.Administrator);

  if (!hasAdminPermission) {
    await interaction.reply({
      content: 'Apenas administradores podem alterar as configurações do bot.',
      ephemeral: true,
    });
    return;
  }

  try {
    const payload = buildConfigPanelPayload({
      content: 'Use os botões abaixo para ajustar as configurações do bot.',
    });

    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });

    await registerConfigPanelMessage(interaction.user.id, message);
  } catch (error) {
    console.error('Falha ao exibir painel de configuração:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Não foi possível abrir o painel de configuração. Tente novamente mais tarde.',
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: 'Não foi possível abrir o painel de configuração. Tente novamente mais tarde.',
        ephemeral: true,
      });
    }
  }
}

async function handleConfigButtonInteraction(interaction) {
  const customId = interaction.customId;

  if (customId === CONFIG_BUTTON_IDS.toggleChat) {
    const currentConfig = getConfig();
    const nextChatEnabled = !currentConfig.chatEnabled;
    updateConfig({ chatEnabled: nextChatEnabled });
    const payload = buildConfigPanelPayload({
      content: nextChatEnabled
        ? '✅ O comando /chat foi ativado. Use o painel para ajustar outras opções.'
        : '🚫 O comando /chat foi desativado. Ative novamente quando desejar.',
    });

    await interaction.update(payload);
    rememberConfigPanelMessage(interaction.user.id, interaction.message);

    if (!nextChatEnabled) {
      cooldowns.clear();
    }

    return;
  }

  if (customId === CONFIG_BUTTON_IDS.setRateLimit) {
    const currentConfig = getConfig();
    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.setRateLimit)
      .setTitle('Intervalo mínimo entre mensagens')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.rateSeconds)
            .setLabel(`Intervalo em segundos (${MIN_RATE_LIMIT_SECONDS}-${MAX_RATE_LIMIT_SECONDS})`)
            .setPlaceholder('Ex: 10')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(Math.max(MIN_RATE_LIMIT_SECONDS, Math.round(currentConfig.rateLimitMs / 1000)).toString()),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.setMaxAttachment) {
    const currentConfig = getConfig();
    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.setMaxAttachment)
      .setTitle('Tamanho máximo dos anexos (MB)')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.maxAttachmentMb)
            .setLabel(`Tamanho em MB (${MIN_ATTACHMENT_SIZE_MB}-${MAX_ATTACHMENT_SIZE_MB})`)
            .setPlaceholder('Ex: 8')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue((currentConfig.maxAttachmentBytes / 1024 / 1024).toFixed(1)),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (customId === CONFIG_BUTTON_IDS.addApiKey) {
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
    const modal = new ModalBuilder()
      .setCustomId(CONFIG_MODAL_IDS.removeApiKey)
      .setTitle('Remover API key do Gemini')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(CONFIG_TEXT_INPUT_IDS.removeKeyIndex)
            .setLabel('Número da API key para remover (ex: 1)')
            .setPlaceholder('Informe o número exibido no painel')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );

    await interaction.showModal(modal);
  }
}

async function handleConfigModalInteraction(interaction) {
  const { customId } = interaction;

  if (customId === CONFIG_MODAL_IDS.setRateLimit) {
    const rawValue = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.rateSeconds)
      .trim()
      .replace(',', '.');
    const seconds = Number(rawValue);

    if (!Number.isFinite(seconds)) {
      const payload = buildConfigPanelPayload({
        content: '❌ Informe um número válido para o intervalo mínimo (em segundos).',
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    if (seconds < MIN_RATE_LIMIT_SECONDS || seconds > MAX_RATE_LIMIT_SECONDS) {
      const payload = buildConfigPanelPayload({
        content: `❌ O intervalo deve estar entre ${MIN_RATE_LIMIT_SECONDS}s e ${MAX_RATE_LIMIT_SECONDS}s.`,
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const rateLimitMs = Math.round(seconds * 1000);
    const currentConfig = getConfig();

    if (rateLimitMs === currentConfig.rateLimitMs) {
      const payload = buildConfigPanelPayload({
        content: 'ℹ️ O intervalo informado já está configurado.',
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const newConfig = updateConfig({ rateLimitMs });
    cooldowns.clear();

    const payload = buildConfigPanelPayload({
      content: `✅ Intervalo mínimo atualizado para ${(newConfig.rateLimitMs / 1000).toFixed(1)}s.`,
    });
    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });
    await registerConfigPanelMessage(interaction.user.id, message);
    return;
  }

  if (customId === CONFIG_MODAL_IDS.setMaxAttachment) {
    const rawValue = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.maxAttachmentMb)
      .trim()
      .replace(',', '.');
    const megabytes = Number(rawValue);

    if (!Number.isFinite(megabytes)) {
      const payload = buildConfigPanelPayload({
        content: '❌ Informe um número válido para o tamanho máximo (em MB).',
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    if (megabytes < MIN_ATTACHMENT_SIZE_MB || megabytes > MAX_ATTACHMENT_SIZE_MB) {
      const payload = buildConfigPanelPayload({
        content: `❌ O tamanho deve estar entre ${MIN_ATTACHMENT_SIZE_MB} MB e ${MAX_ATTACHMENT_SIZE_MB} MB.`,
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const maxAttachmentBytes = Math.round(megabytes * 1024 * 1024);
    const currentConfig = getConfig();

    if (maxAttachmentBytes === currentConfig.maxAttachmentBytes) {
      const payload = buildConfigPanelPayload({
        content: 'ℹ️ O tamanho informado já está configurado.',
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
      return;
    }

    const newConfig = updateConfig({ maxAttachmentBytes });

    const payload = buildConfigPanelPayload({
      content: `✅ Tamanho máximo atualizado para ${(newConfig.maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB.`,
    });
    const message = await interaction.reply({
      ...payload,
      ephemeral: true,
      fetchReply: true,
    });
    await registerConfigPanelMessage(interaction.user.id, message);
    return;
  }

  if (customId === CONFIG_MODAL_IDS.addApiKey) {
    const apiKey = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.apiKeyValue)
      .trim();

    if (!apiKey) {
      const payload = buildConfigPanelPayload({
        content: '❌ Informe uma API key válida para adicioná-la.',
      });
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

      const payload = buildConfigPanelPayload({
        content: '✅ API key adicionada com sucesso.',
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    } catch (error) {
      console.error('Falha ao adicionar API key:', error);
      const payload = buildConfigPanelPayload({
        content: `❌ Não foi possível adicionar a API key: ${error.message || 'erro desconhecido.'}`,
      });
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
    const rawIndex = interaction.fields
      .getTextInputValue(CONFIG_TEXT_INPUT_IDS.removeKeyIndex)
      .trim();
    const parsedIndex = Number.parseInt(rawIndex, 10);

    if (!Number.isInteger(parsedIndex) || parsedIndex < 1) {
      const payload = buildConfigPanelPayload({
        content: '❌ Informe o número da API key exatamente como exibido no painel.',
      });
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

      const payload = buildConfigPanelPayload({
        content: `✅ API key número ${parsedIndex} removida com sucesso.`,
      });
      const message = await interaction.reply({
        ...payload,
        ephemeral: true,
        fetchReply: true,
      });
      await registerConfigPanelMessage(interaction.user.id, message);
    } catch (error) {
      console.error('Falha ao remover API key:', error);
      const payload = buildConfigPanelPayload({
        content: `❌ Não foi possível remover a API key: ${error.message || 'erro desconhecido.'}`,
      });
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
