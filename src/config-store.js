const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'bot-config.json');

const DEFAULT_CONFIG = {
  rateLimitMs: 10000,
  maxAttachmentBytes: 8 * 1024 * 1024,
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
  }

  return setConfig(merged);
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  getConfig,
  updateConfig,
};
