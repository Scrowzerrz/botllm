const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'bot-config.json');

const DEFAULT_GUILD_CONFIG = {
  maxAttachmentBytes: 8 * 1024 * 1024,
};

const DEFAULT_GLOBAL_CONFIG = {
  rateLimitMs: null,
};

const DEFAULT_STATE = {
  global: { ...DEFAULT_GLOBAL_CONFIG },
  guilds: {},
};

let cachedState = null;

function sanitizeGuildConfig(config) {
  const sanitized = { ...DEFAULT_GUILD_CONFIG };

  if (config && typeof config === 'object') {
    if (Number.isFinite(config.maxAttachmentBytes) && config.maxAttachmentBytes >= 1024) {
      sanitized.maxAttachmentBytes = Math.round(config.maxAttachmentBytes);
    }
  }

  return sanitized;
}

function sanitizeGlobalConfig(config) {
  const sanitized = { ...DEFAULT_GLOBAL_CONFIG };

  if (config && typeof config === 'object') {
    if (Number.isFinite(config.rateLimitMs) && config.rateLimitMs >= 0) {
      sanitized.rateLimitMs = Math.round(config.rateLimitMs);
    }
  }

  return sanitized;
}

function sanitizeState(state) {
  const sanitized = { global: { ...DEFAULT_GLOBAL_CONFIG }, guilds: {} };

  if (state && typeof state === 'object') {
    const { global } = state;
    if (global && typeof global === 'object') {
      sanitized.global = sanitizeGlobalConfig(global);
    }

    const { guilds } = state;
    if (guilds && typeof guilds === 'object') {
      for (const [guildId, guildConfig] of Object.entries(guilds)) {
        if (typeof guildId === 'string' && guildId.length > 0) {
          sanitized.guilds[guildId] = sanitizeGuildConfig(guildConfig);
        }
      }
    }
  }

  return sanitized;
}

function persistState(state) {
  const data = JSON.stringify(state, null, 2);
  fs.writeFileSync(CONFIG_PATH, data, 'utf8');
}

function loadStateFromDisk() {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(fileContents);
    return sanitizeState(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Falha ao carregar bot-config.json, usando valores padrão:', error);
    }

    const defaults = { ...DEFAULT_STATE };

    try {
      persistState(defaults);
    } catch (persistError) {
      console.warn('Não foi possível salvar bot-config.json com os valores padrão:', persistError);
    }

    return defaults;
  }
}

function ensureStateLoaded() {
  if (!cachedState) {
    cachedState = loadStateFromDisk();
  }
}

function getGuildConfig(guildId) {
  ensureStateLoaded();

  if (!guildId) {
    return { ...DEFAULT_GUILD_CONFIG };
  }

  const existing = cachedState.guilds[guildId];
  if (existing) {
    return { ...existing };
  }

  const defaults = sanitizeGuildConfig();
  cachedState.guilds[guildId] = defaults;

  try {
    persistState(cachedState);
  } catch (error) {
    console.warn('Não foi possível persistir configuração padrão para o servidor:', error);
  }

  return { ...defaults };
}

function setGuildConfig(guildId, partialConfig) {
  if (!guildId) {
    throw new Error('guildId é obrigatório para atualizar a configuração.');
  }

  ensureStateLoaded();

  const current = cachedState.guilds[guildId] || DEFAULT_GUILD_CONFIG;
  const merged = { ...current };

  if (partialConfig && typeof partialConfig === 'object') {
    if (Number.isFinite(partialConfig.maxAttachmentBytes)) {
      merged.maxAttachmentBytes = Math.max(1024, Math.round(partialConfig.maxAttachmentBytes));
    }
  }

  const sanitized = sanitizeGuildConfig(merged);
  cachedState.guilds[guildId] = sanitized;

  persistState(cachedState);

  return { ...sanitized };
}

function getGlobalConfig() {
  ensureStateLoaded();
  return { ...cachedState.global };
}

function setGlobalConfig(partialConfig) {
  ensureStateLoaded();

  const merged = { ...cachedState.global };

  if (partialConfig && typeof partialConfig === 'object') {
    if (Object.prototype.hasOwnProperty.call(partialConfig, 'rateLimitMs')) {
      const { rateLimitMs } = partialConfig;
      if (Number.isFinite(rateLimitMs) && rateLimitMs >= 0) {
        merged.rateLimitMs = Math.round(rateLimitMs);
      } else {
        merged.rateLimitMs = null;
      }
    }
  }

  const sanitized = sanitizeGlobalConfig(merged);
  cachedState.global = sanitized;

  persistState(cachedState);

  return { ...sanitized };
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_GUILD_CONFIG,
  DEFAULT_GLOBAL_CONFIG,
  getGuildConfig,
  setGuildConfig,
  getGlobalConfig,
  setGlobalConfig,
};
