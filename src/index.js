require('dotenv').config();
const path = require('node:path');
const {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionFlagsBits,
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { commands, attachmentOptionNames } = require('./commands');
const { getConfig, updateConfig } = require('./config-store');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN) {
  console.error('Configure a variavel de ambiente DISCORD_TOKEN antes de iniciar.');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('Configure a variavel de ambiente GEMINI_API_KEY antes de iniciar.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

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
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === 'chat') {
    await handleChatCommand(interaction);
    return;
  }

  if (interaction.commandName === 'configurar') {
    await handleConfigureCommand(interaction);
  }
});

async function handleChatCommand(interaction) {
  const config = getConfig();
  const { rateLimitMs, maxAttachmentBytes } = config;

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

    const result = await model.generateContent(requestPayload);
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
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(
          'Desculpe, ocorreu um erro ao falar com o modelo. Tente novamente em instantes.'
        );
      } else {
        await interaction.reply(
          'Desculpe, ocorreu um erro ao falar com o modelo. Tente novamente em instantes.'
        );
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

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'ver') {
    const config = getConfig();
    const summary =
      `Intervalo mínimo entre mensagens: ${(config.rateLimitMs / 1000).toFixed(1)}s\n` +
      `Tamanho máximo dos anexos: ${(config.maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB`;

    await interaction.reply({ content: summary, ephemeral: true });
    return;
  }

  if (subcommand === 'definir') {
    const currentConfig = getConfig();
    const intervalSeconds = interaction.options.getInteger('intervalo_segundos');
    const maxAttachmentMb = interaction.options.getNumber('tamanho_max_mb');

    if (intervalSeconds === null && maxAttachmentMb === null) {
      await interaction.reply({
        content: 'Informe pelo menos um parâmetro para atualizar (intervalo ou tamanho máximo).',
        ephemeral: true,
      });
      return;
    }

    const updates = {};
    let rateLimitChanged = false;

    if (intervalSeconds !== null) {
      const nextRateLimitMs = intervalSeconds * 1000;
      if (nextRateLimitMs !== currentConfig.rateLimitMs) {
        updates.rateLimitMs = nextRateLimitMs;
        rateLimitChanged = true;
      }
    }

    if (maxAttachmentMb !== null) {
      const nextMaxBytes = Math.round(maxAttachmentMb * 1024 * 1024);
      if (nextMaxBytes !== currentConfig.maxAttachmentBytes) {
        updates.maxAttachmentBytes = nextMaxBytes;
      }
    }

    if (Object.keys(updates).length === 0) {
      await interaction.reply({
        content: 'Os valores informados são iguais aos atuais; nada foi alterado.',
        ephemeral: true,
      });
      return;
    }

    try {
      const newConfig = updateConfig(updates);

      if (rateLimitChanged) {
        cooldowns.clear();
      }

      const responseMessage =
        'Configurações atualizadas com sucesso:\n' +
        `• Intervalo mínimo: ${(newConfig.rateLimitMs / 1000).toFixed(1)}s\n` +
        `• Tamanho máximo dos anexos: ${(newConfig.maxAttachmentBytes / 1024 / 1024).toFixed(1)} MB`;

      await interaction.reply({ content: responseMessage, ephemeral: true });
    } catch (error) {
      console.error('Falha ao atualizar configurações do bot:', error);
      await interaction.reply({
        content: 'Não foi possível salvar as configurações. Tente novamente mais tarde.',
        ephemeral: true,
      });
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
