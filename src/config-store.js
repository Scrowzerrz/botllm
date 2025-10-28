const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'bot-config.json');

const DEFAULT_CONFIG = {
  rateLimitMs: 10000,
  maxAttachmentBytes: 8 * 1024 * 1024,
  chatEnabled: true,
  apiKeys: [],
};

let cachedConfig = null;

function sanitizeConfig(config) {
  const sanitized = { ...DEFAULT_CONFIG };

  if (config && typeof config === 'object') {
    if (Number.isFinite(config.rateLimitMs) && config.rateLimitMs >= 0) {
      sanitized.rateLimitMs = Math.round(config.rateLimitMs);
    }

    if (Number.isFinite(config.maxAttachmentBytes) && config.maxAttachmentBytes >= 1024) {
      sanitized.maxAttachmentBytes = Math.round(config.maxAttachmentBytes);
    }

    if (typeof config.chatEnabled === 'boolean') {
      sanitized.chatEnabled = config.chatEnabled;
    }

    if (Array.isArray(config.apiKeys)) {
      sanitized.apiKeys = config.apiKeys
        .map(apiKey => (typeof apiKey === 'string' ? apiKey.trim() : ''))
        .filter(Boolean);
    }
  }

  return sanitized;
}

function persistConfig(config) {
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_PATH, data, 'utf8');
}

function loadConfigFromDisk() {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(fileContents);
    return sanitizeConfig(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Falha ao carregar bot-config.json, usando valores padrão:', error);
    }

    const defaults = { ...DEFAULT_CONFIG };

    try {
      persistConfig(defaults);
    } catch (persistError) {
      console.warn('Não foi possível salvar bot-config.json com os valores padrão:', persistError);
    }

    return defaults;
  }
}

function ensureConfigLoaded() {
  if (!cachedConfig) {
    cachedConfig = loadConfigFromDisk();
  }
}

function getConfig() {
  ensureConfigLoaded();
  return { ...cachedConfig };
}

function setConfig(newConfig) {
  cachedConfig = sanitizeConfig(newConfig);
  persistConfig(cachedConfig);
  return getConfig();
}

function updateConfig(partialConfig) {
  ensureConfigLoaded();

  const merged = { ...cachedConfig };

  if (partialConfig && typeof partialConfig === 'object') {
    if (Number.isFinite(partialConfig.rateLimitMs)) {
      merged.rateLimitMs = Math.max(0, Math.round(partialConfig.rateLimitMs));
    }

    if (Number.isFinite(partialConfig.maxAttachmentBytes)) {
      merged.maxAttachmentBytes = Math.max(1024, Math.round(partialConfig.maxAttachmentBytes));
    }

    if (typeof partialConfig.chatEnabled === 'boolean') {
      merged.chatEnabled = partialConfig.chatEnabled;
    }

    if (Array.isArray(partialConfig.apiKeys)) {
      merged.apiKeys = partialConfig.apiKeys
        .map(apiKey => (typeof apiKey === 'string' ? apiKey.trim() : ''))
        .filter(Boolean);
    }
  }

  return setConfig(merged);
}

function addApiKey(apiKey) {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (!trimmed) {
    throw new Error('A chave da API não pode ser vazia.');
  }

  ensureConfigLoaded();

  if (cachedConfig.apiKeys.includes(trimmed)) {
    throw new Error('Esta chave da API já está cadastrada.');
  }

  const updated = { ...cachedConfig, apiKeys: [...cachedConfig.apiKeys, trimmed] };
  return setConfig(updated);
}

function removeApiKeyAt(index) {
  ensureConfigLoaded();

  const numericIndex = Number(index);

  if (!Number.isInteger(numericIndex)) {
    throw new Error('Índice inválido para remoção da chave da API.');
  }

  if (numericIndex < 0 || numericIndex >= cachedConfig.apiKeys.length) {
    throw new Error('Nenhuma chave da API encontrada na posição informada.');
  }

  const nextKeys = [...cachedConfig.apiKeys];
  const [removed] = nextKeys.splice(numericIndex, 1);

  const updated = { ...cachedConfig, apiKeys: nextKeys };
  return { config: setConfig(updated), removedApiKey: removed };
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
  addApiKey,
  removeApiKeyAt,
};
